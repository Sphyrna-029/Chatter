use super::super::{
    dto::{CreateRoomGroupRequest, SetGroupCollapsedRequest, SetGroupRoomsRequest, UpdateRoomGroupRequest},
    helpers::{error_response, extract_token, generate_id, get_user_from_token},
    state::{AppState, RoomGroupEntry, UserRoomGroupsRecord},
};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::Json,
};
use mongodb::bson::doc;
use mongodb::options::ReplaceOptions;
use serde_json::{json, Value};
use std::sync::Arc;

/// Helper: load the user's room groups document (or create a default empty one).
async fn load_groups(state: &AppState, user_id: &str) -> UserRoomGroupsRecord {
    let coll = state.db.collection::<UserRoomGroupsRecord>("room_groups");
    match coll.find_one(doc! { "_id": user_id }).await {
        Ok(Some(rec)) => rec,
        _ => UserRoomGroupsRecord {
            user_id: user_id.to_string(),
            groups: Vec::new(),
        },
    }
}

/// Helper: save (upsert) the user's room groups document.
async fn save_groups(state: &AppState, rec: &UserRoomGroupsRecord) -> Result<(), (StatusCode, Json<Value>)> {
    let coll = state.db.collection::<UserRoomGroupsRecord>("room_groups");
    coll.replace_one(doc! { "_id": &rec.user_id }, rec)
        .with_options(ReplaceOptions::builder().upsert(true).build())
        .await
        .map_err(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "Database error"))?;
    Ok(())
}

/// GET /api/room-groups
pub(crate) async fn get_room_groups(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let rec = load_groups(&state, &user_id).await;
    let groups: Vec<Value> = rec.groups.iter().map(|g| {
        json!({
            "group_id": g.group_id,
            "name": g.name,
            "position": g.position,
            "collapsed": g.collapsed,
            "room_ids": g.room_ids,
        })
    }).collect();
    Ok(Json(json!({ "groups": groups })))
}

/// POST /api/room-groups
pub(crate) async fn create_room_group(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<CreateRoomGroupRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let name = body.name.trim().to_string();
    if name.is_empty() {
        return Err(error_response(StatusCode::BAD_REQUEST, "Group name cannot be empty"));
    }

    let mut rec = load_groups(&state, &user_id).await;
    let position = rec.groups.len() as i32;
    let group_id = generate_id("g");
    rec.groups.push(RoomGroupEntry {
        group_id: group_id.clone(),
        name,
        position,
        collapsed: false,
        room_ids: Vec::new(),
    });
    save_groups(&state, &rec).await?;
    Ok(Json(json!({ "group_id": group_id })))
}

/// PUT /api/room-groups/{group_id}
pub(crate) async fn update_room_group(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(group_id): Path<String>,
    Json(body): Json<UpdateRoomGroupRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let mut rec = load_groups(&state, &user_id).await;
    let group = rec.groups.iter_mut().find(|g| g.group_id == group_id)
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Group not found"))?;

    if let Some(name) = body.name {
        let name = name.trim().to_string();
        if name.is_empty() {
            return Err(error_response(StatusCode::BAD_REQUEST, "Group name cannot be empty"));
        }
        group.name = name;
    }
    if let Some(pos) = body.position {
        group.position = pos;
    }
    save_groups(&state, &rec).await?;
    Ok(Json(json!({ "ok": true })))
}

/// DELETE /api/room-groups/{group_id}
pub(crate) async fn delete_room_group(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(group_id): Path<String>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let mut rec = load_groups(&state, &user_id).await;
    let before_len = rec.groups.len();
    rec.groups.retain(|g| g.group_id != group_id);
    if rec.groups.len() == before_len {
        return Err(error_response(StatusCode::NOT_FOUND, "Group not found"));
    }
    save_groups(&state, &rec).await?;
    Ok(Json(json!({ "ok": true })))
}

/// PUT /api/room-groups/{group_id}/rooms
pub(crate) async fn set_group_rooms(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(group_id): Path<String>,
    Json(body): Json<SetGroupRoomsRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let mut rec = load_groups(&state, &user_id).await;

    // Remove these room_ids from all other groups first (a room can only be in one group)
    let new_ids_set: std::collections::HashSet<&str> = body.room_ids.iter().map(|s| s.as_str()).collect();
    for g in rec.groups.iter_mut() {
        if g.group_id != group_id {
            g.room_ids.retain(|rid| !new_ids_set.contains(rid.as_str()));
        }
    }

    let group = rec.groups.iter_mut().find(|g| g.group_id == group_id)
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Group not found"))?;
    group.room_ids = body.room_ids;
    save_groups(&state, &rec).await?;
    Ok(Json(json!({ "ok": true })))
}

/// PUT /api/room-groups/{group_id}/collapsed
pub(crate) async fn set_group_collapsed(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(group_id): Path<String>,
    Json(body): Json<SetGroupCollapsedRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let mut rec = load_groups(&state, &user_id).await;
    let group = rec.groups.iter_mut().find(|g| g.group_id == group_id)
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Group not found"))?;
    group.collapsed = body.collapsed;
    save_groups(&state, &rec).await?;
    Ok(Json(json!({ "ok": true })))
}
