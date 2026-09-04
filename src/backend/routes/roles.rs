use super::super::{
    dto::{
        AssignMemberRolesRequest, CreateCustomRoleRequest, PermissionsQuery,
        UpdateCustomRoleRequest,
    },
    helpers::{
        apply_overwrites, broadcast_to_room, category_overwrites, channel_permissions,
        effective_permissions, error_response, extract_token, generate_id, get_user_from_token,
        merged_overwrites, now_millis, outranks_role, role_authority, ungrantable_permission,
    },
    state::{AppState, ChannelRecord, CustomRoleRecord, MemberCustomRoleRecord, RolePermissions},
};
use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::Json,
};
use futures_util::TryStreamExt;
use mongodb::bson::doc;
use serde_json::{json, Value};
use std::sync::Arc;

fn role_to_json(r: &CustomRoleRecord) -> Value {
    json!({
        "role_id": r.role_id,
        "room_id": r.room_id,
        "name": r.name,
        "color": r.color,
        "position": r.position,
        // Serialized from the struct so a new permission can never be silently
        // dropped from the API by a hand-maintained field list.
        "permissions": serde_json::to_value(r.permissions).unwrap_or_default(),
        "created_by": r.created_by,
        "created_at": r.created_at,
    })
}

// GET /api/rooms/{room_id}/roles
pub(crate) async fn list_roles(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    // Check membership
    {
        let rm = state.room_members.read().await;
        if !rm
            .get(&room_id)
            .map(|m| m.contains(&user_id))
            .unwrap_or(false)
        {
            return Err(error_response(
                StatusCode::FORBIDDEN,
                "Not a member of this room",
            ));
        }
    }

    let coll = state.db.collection::<CustomRoleRecord>("custom_roles");
    let mut cursor = coll
        .find(doc! { "room_id": &room_id })
        .sort(doc! { "position": 1, "created_at": 1 })
        .await
        .map_err(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "DB query failed"))?;

    let mut roles: Vec<Value> = Vec::new();
    while let Ok(Some(r)) = cursor.try_next().await {
        roles.push(role_to_json(&r));
    }

    Ok(Json(json!({ "roles": roles })))
}

// POST /api/rooms/{room_id}/roles
pub(crate) async fn create_role(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
    Json(req): Json<CreateCustomRoleRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    // Membership gate — must precede role check so ex-members cannot act on the room.
    {
        let rm = state.room_members.read().await;
        if !rm
            .get(&room_id)
            .map(|m| m.contains(&user_id))
            .unwrap_or(false)
        {
            return Err(error_response(
                StatusCode::FORBIDDEN,
                "Not a member of this room",
            ));
        }
    }

    if !effective_permissions(&state, &room_id, &user_id)
        .await
        .manage_roles
    {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "You do not have permission to create roles",
        ));
    }

    let name: String = req.name.trim().chars().take(30).collect();
    if name.is_empty() {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "Role name cannot be empty",
        ));
    }

    // Without this, manage_roles would be a route to every other permission:
    // create a role holding them and assign it to yourself.
    if let Some(ref perms) = req.permissions {
        if let Some(name) = ungrantable_permission(&state, &room_id, &user_id, perms).await {
            return Err(error_response(
                StatusCode::FORBIDDEN,
                &format!("You cannot grant a permission you do not hold: {name}"),
            ));
        }
    }

    let coll = state.db.collection::<CustomRoleRecord>("custom_roles");
    let max_pos = coll
        .count_documents(doc! { "room_id": &room_id })
        .await
        .unwrap_or(0) as i32;

    let role_id = generate_id("role");
    let record = CustomRoleRecord {
        role_id: role_id.clone(),
        room_id: room_id.clone(),
        name,
        color: req.color.unwrap_or_default(),
        position: max_pos,
        permissions: req.permissions.unwrap_or_default(),
        created_by: user_id.clone(),
        created_at: now_millis(),
    };

    let _ = coll.insert_one(&record).await;

    let event = json!({
        "type": "m.room.role_created",
        "room_id": room_id,
        "sender": user_id,
        "role": role_to_json(&record),
    });
    broadcast_to_room(&state, &room_id, &event).await;

    Ok(Json(json!({ "role_id": role_id })))
}

// PUT /api/rooms/{room_id}/roles/{role_id}
pub(crate) async fn update_role(
    State(state): State<Arc<AppState>>,
    Path((room_id, role_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(req): Json<UpdateCustomRoleRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    if !effective_permissions(&state, &room_id, &user_id)
        .await
        .manage_roles
    {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "You do not have permission to edit roles",
        ));
    }

    let coll = state.db.collection::<CustomRoleRecord>("custom_roles");
    let existing = coll
        .find_one(doc! { "_id": &role_id, "room_id": &room_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Role not found"))?;

    // Hierarchy: you may only edit roles beneath your own highest one.
    if !outranks_role(&state, &room_id, &user_id, existing.position).await {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "You cannot edit a role at or above your own highest role",
        ));
    }
    if let Some(ref perms) = req.permissions {
        if let Some(name) = ungrantable_permission(&state, &room_id, &user_id, perms).await {
            return Err(error_response(
                StatusCode::FORBIDDEN,
                &format!("You cannot grant a permission you do not hold: {name}"),
            ));
        }
    }
    // Nor may you move a role up past yourself.
    if let Some(position) = req.position {
        if !outranks_role(&state, &room_id, &user_id, position).await {
            return Err(error_response(
                StatusCode::FORBIDDEN,
                "You cannot move a role to or above your own highest role",
            ));
        }
    }

    let mut set_doc = mongodb::bson::Document::new();
    let mut content = serde_json::Map::new();
    content.insert("role_id".to_string(), json!(role_id));

    if let Some(ref name) = req.name {
        let sanitized: String = name.trim().chars().take(30).collect();
        if sanitized.is_empty() {
            return Err(error_response(
                StatusCode::BAD_REQUEST,
                "Role name cannot be empty",
            ));
        }
        set_doc.insert("name", sanitized.as_str());
        content.insert("name".to_string(), json!(sanitized));
    }
    if let Some(ref color) = req.color {
        set_doc.insert("color", color.as_str());
        content.insert("color".to_string(), json!(color));
    }
    if let Some(position) = req.position {
        set_doc.insert("position", position);
        content.insert("position".to_string(), json!(position));
    }
    if let Some(ref perms) = req.permissions {
        let perms_doc = mongodb::bson::to_bson(perms)
            .map_err(|_| error_response(StatusCode::BAD_REQUEST, "Invalid permissions"))?;
        set_doc.insert("permissions", perms_doc.clone());
        content.insert(
            "permissions".to_string(),
            serde_json::to_value(perms).unwrap_or_default(),
        );
    }

    if !set_doc.is_empty() {
        let _ = coll
            .update_one(
                doc! { "_id": &role_id, "room_id": &room_id },
                doc! { "$set": set_doc },
            )
            .await;
    }

    let event = json!({
        "type": "m.room.role_updated",
        "room_id": room_id,
        "sender": user_id,
        "content": Value::Object(content),
    });
    broadcast_to_room(&state, &room_id, &event).await;

    Ok(Json(json!({ "updated": true })))
}

// DELETE /api/rooms/{room_id}/roles/{role_id}
pub(crate) async fn delete_role(
    State(state): State<Arc<AppState>>,
    Path((room_id, role_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    if !effective_permissions(&state, &room_id, &user_id)
        .await
        .manage_roles
    {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "You do not have permission to delete roles",
        ));
    }

    let coll = state.db.collection::<CustomRoleRecord>("custom_roles");
    let existing = coll
        .find_one(doc! { "_id": &role_id, "room_id": &room_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Role not found"))?;
    if !outranks_role(&state, &room_id, &user_id, existing.position).await {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "You cannot delete a role at or above your own highest role",
        ));
    }

    let _ = coll
        .delete_one(doc! { "_id": &role_id, "room_id": &room_id })
        .await;

    // Remove all member assignments for this role
    let assign_coll = state
        .db
        .collection::<MemberCustomRoleRecord>("member_custom_roles");
    let _ = assign_coll
        .delete_many(doc! { "room_id": &room_id, "role_id": &role_id })
        .await;

    // Remove this role from channel view_roles and write_roles
    let channels_coll = state.db.collection::<mongodb::bson::Document>("channels");
    let _ = channels_coll
        .update_many(
            doc! { "room_id": &room_id },
            doc! { "$pull": {
                "view_roles": &role_id,
                "write_roles": &role_id,
                "overwrites": { "target_type": "role", "target_id": &role_id }
            } },
        )
        .await;

    let event = json!({
        "type": "m.room.role_deleted",
        "room_id": room_id,
        "sender": user_id,
        "role_id": role_id,
    });
    broadcast_to_room(&state, &room_id, &event).await;

    Ok(Json(json!({ "deleted": true })))
}

// GET /api/rooms/{room_id}/members/{user_id}/custom-roles
pub(crate) async fn get_member_roles(
    State(state): State<Arc<AppState>>,
    Path((room_id, target_user_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    {
        let rm = state.room_members.read().await;
        if !rm
            .get(&room_id)
            .map(|m| m.contains(&user_id))
            .unwrap_or(false)
        {
            return Err(error_response(
                StatusCode::FORBIDDEN,
                "Not a member of this room",
            ));
        }
    }

    let coll = state
        .db
        .collection::<MemberCustomRoleRecord>("member_custom_roles");
    let mut cursor = coll
        .find(doc! { "room_id": &room_id, "user_id": &target_user_id })
        .await
        .map_err(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "DB query failed"))?;

    let mut role_ids: Vec<String> = Vec::new();
    while let Ok(Some(r)) = cursor.try_next().await {
        role_ids.push(r.role_id);
    }

    Ok(Json(json!({ "role_ids": role_ids })))
}

// PUT /api/rooms/{room_id}/members/{user_id}/custom-roles
pub(crate) async fn assign_member_roles(
    State(state): State<Arc<AppState>>,
    Path((room_id, target_user_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(req): Json<AssignMemberRolesRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    if !effective_permissions(&state, &room_id, &user_id)
        .await
        .manage_roles
    {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "You do not have permission to assign roles",
        ));
    }

    // Hierarchy: you may not restyle someone who outranks you, and you may not
    // hand out a role you could not edit. Without both, manage_roles would let
    // a holder assign themselves anything that exists.
    let caller_authority = role_authority(&state, &room_id, &user_id).await;
    if role_authority(&state, &room_id, &target_user_id).await <= caller_authority
        && target_user_id != user_id
    {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "You cannot change the roles of a member at or above your own rank",
        ));
    }

    let roles_coll = state.db.collection::<CustomRoleRecord>("custom_roles");
    for role_id in &req.role_ids {
        let role = roles_coll
            .find_one(doc! { "_id": role_id, "room_id": &room_id })
            .await
            .ok()
            .flatten()
            .ok_or_else(|| error_response(StatusCode::BAD_REQUEST, "Unknown role"))?;
        if role.position <= caller_authority {
            return Err(error_response(
                StatusCode::FORBIDDEN,
                "You cannot assign a role at or above your own highest role",
            ));
        }
    }

    let coll = state
        .db
        .collection::<MemberCustomRoleRecord>("member_custom_roles");

    // Roles the caller cannot reach must survive the rewrite, so this only
    // clears assignments the caller is actually allowed to manage.
    let mut preserved: Vec<String> = Vec::new();
    if let Ok(mut cursor) = coll
        .find(doc! { "room_id": &room_id, "user_id": &target_user_id })
        .await
    {
        use futures_util::TryStreamExt;
        while let Ok(Some(existing)) = cursor.try_next().await {
            if let Ok(Some(role)) = roles_coll
                .find_one(doc! { "_id": &existing.role_id, "room_id": &room_id })
                .await
            {
                if role.position <= caller_authority {
                    preserved.push(existing.role_id.clone());
                }
            }
        }
    }

    // Remove all existing assignments for this user in this room
    let _ = coll
        .delete_many(doc! { "room_id": &room_id, "user_id": &target_user_id })
        .await;

    for role_id in &preserved {
        let _ = coll
            .insert_one(MemberCustomRoleRecord {
                room_id: room_id.clone(),
                user_id: target_user_id.clone(),
                role_id: role_id.clone(),
            })
            .await;
    }

    // Insert new assignments
    for role_id in req.role_ids.iter().filter(|r| !preserved.contains(r)) {
        let _ = coll
            .insert_one(MemberCustomRoleRecord {
                room_id: room_id.clone(),
                user_id: target_user_id.clone(),
                role_id: role_id.clone(),
            })
            .await;
    }

    let event = json!({
        "type": "m.room.member_roles_updated",
        "room_id": room_id,
        "sender": user_id,
        "user_id": target_user_id,
        "role_ids": req.role_ids,
    });
    broadcast_to_room(&state, &room_id, &event).await;

    Ok(Json(json!({ "updated": true })))
}

// GET /api/rooms/{room_id}/member-roles
pub(crate) async fn list_all_member_roles(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    {
        let rm = state.room_members.read().await;
        if !rm
            .get(&room_id)
            .map(|m| m.contains(&user_id))
            .unwrap_or(false)
        {
            return Err(error_response(
                StatusCode::FORBIDDEN,
                "Not a member of this room",
            ));
        }
    }

    let coll = state
        .db
        .collection::<MemberCustomRoleRecord>("member_custom_roles");
    let mut cursor = coll
        .find(doc! { "room_id": &room_id })
        .await
        .map_err(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "DB query failed"))?;

    // Build map: user_id -> [role_id, ...]
    let mut map: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    while let Ok(Some(r)) = cursor.try_next().await {
        map.entry(r.user_id).or_default().push(r.role_id);
    }

    Ok(Json(json!({ "member_roles": map })))
}

/// GET /api/rooms/{room_id}/permissions
///
/// The caller's own effective permissions, so the client can hide controls the
/// server would refuse anyway.
pub(crate) async fn get_my_permissions(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<PermissionsQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let channel_id = query.channel_id.as_deref().filter(|c| !c.is_empty());
    let as_user = query.as_user.as_deref().filter(|u| !u.is_empty());
    let as_role = query.as_role.as_deref().filter(|r| !r.is_empty());

    // Inspecting someone else's access is itself a moderation power.
    if (as_user.is_some() || as_role.is_some())
        && !effective_permissions(&state, &room_id, &user_id)
            .await
            .manage_roles
    {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "You do not have permission to inspect other members' access",
        ));
    }

    let perms = if let Some(role_id) = as_role {
        // A hypothetical member holding only this role, so an admin can see
        // what a role grants before assigning it to anyone.
        role_view_permissions(&state, &room_id, channel_id, role_id).await?
    } else {
        let subject = as_user.unwrap_or(&user_id);
        match channel_id {
            Some(channel_id) => channel_permissions(&state, &room_id, channel_id, subject).await,
            None => effective_permissions(&state, &room_id, subject).await,
        }
    };

    Ok(Json(json!({
        "permissions": serde_json::to_value(perms).unwrap_or_default(),
    })))
}

/// Resolve permissions for a hypothetical member whose only role is `role_id`,
/// optionally inside one channel. Used by the "view as" preview.
async fn role_view_permissions(
    state: &Arc<AppState>,
    room_id: &str,
    channel_id: Option<&str>,
    role_id: &str,
) -> Result<RolePermissions, (StatusCode, Json<Value>)> {
    let coll = state.db.collection::<CustomRoleRecord>("custom_roles");
    let role = coll
        .find_one(doc! { "_id": role_id, "room_id": room_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Role not found"))?;

    let base = role.permissions;
    let Some(channel_id) = channel_id else {
        return Ok(base);
    };

    let channels_coll = state.db.collection::<ChannelRecord>("channels");
    let Ok(Some(channel)) = channels_coll
        .find_one(doc! { "_id": channel_id, "room_id": room_id })
        .await
    else {
        return Ok(base);
    };

    let inherited = category_overwrites(state, &channel).await;
    Ok(apply_overwrites(
        base,
        &merged_overwrites(&inherited, &channel),
        &[role_id.to_string()],
        "",
    ))
}
