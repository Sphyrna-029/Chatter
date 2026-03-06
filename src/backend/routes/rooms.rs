use super::super::{
    dto::{CreateRoomRequest, JoinRoomRequest, SetNameColorRequest, SetRoleRequest, UpdateRoomSettingsRequest, UpdateTopicRequest},
    helpers::{
        broadcast_to_room, do_join_room, error_response, extract_token, generate_id,
        get_user_from_token, get_user_role, hash_password, now_millis, verify_password,
    },
    state::{AppState, BannedUserRecord, DmRoomRecord, RoomMemberRecord, RoomRecord},
};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::Json,
};
use mongodb::bson::doc;
use serde_json::{json, Value};
use std::sync::Arc;

pub(crate) async fn create_room(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<CreateRoomRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let is_dm = req.is_direct.unwrap_or(false);

    // If it's a DM, check if one already exists
    if is_dm {
        if let Some(invite_list) = &req.invite {
            if invite_list.len() == 1 {
                let other_user = &invite_list[0];

                if *other_user == user_id {
                    return Err(error_response(
                        StatusCode::BAD_REQUEST,
                        "Cannot DM yourself",
                    ));
                }

                let dm_key = if user_id < *other_user {
                    format!("{}|{}", user_id, other_user)
                } else {
                    format!("{}|{}", other_user, user_id)
                };

                // Check MongoDB for existing DM
                let dm_coll = state.db.collection::<DmRoomRecord>("dm_rooms");
                if let Ok(Some(existing)) = dm_coll.find_one(doc! { "_id": &dm_key }).await {
                    let existing_room_id = existing.room_id;

                    // Re-add the user if they left
                    let is_member = {
                        let rm = state.room_members.read().await;
                        rm.get(&existing_room_id)
                            .map(|m| m.contains(&user_id))
                            .unwrap_or(false)
                    };

                    if !is_member {
                        let _ = do_join_room(&state, &existing_room_id, &user_id).await;
                    }

                    return Ok(Json(json!({"room_id": existing_room_id})));
                }

                // Create new DM room
                let room_id = generate_id("!");
                let other_user_name = other_user
                    .split(':')
                    .next()
                    .unwrap_or(other_user)
                    .trim_start_matches('@');
                let room_name = format!("DM with {}", other_user_name);

                let room_record = RoomRecord {
                    room_id: room_id.clone(),
                    name: room_name.clone(),
                    topic: String::from("Direct Message"),
                    creator: user_id.clone(),
                    is_dm: true,
                    tags: vec![],
                    icon_url: String::new(),
                    custom_emojis: vec![],
                    emoji_aliases: std::collections::HashMap::new(),
                    owner_name_color: String::new(),
                    mod_name_color: String::new(),
                    unlisted: false,
                    password_hash: String::new(),
                    room_type: String::new(),
                };
                let rooms_coll = state.db.collection::<RoomRecord>("rooms");
                let _ = rooms_coll.insert_one(room_record).await;

                // Add both members to MongoDB and cache
                let members_coll = state.db.collection::<RoomMemberRecord>("room_members");
                let ts = now_millis();
                let _ = members_coll
                    .insert_one(RoomMemberRecord {
                        room_id: room_id.clone(),
                        user_id: user_id.clone(),
                        role: "owner".to_string(),
                        joined_at: ts,
                    })
                    .await;
                let _ = members_coll
                    .insert_one(RoomMemberRecord {
                        room_id: room_id.clone(),
                        user_id: other_user.clone(),
                        role: "member".to_string(),
                        joined_at: ts,
                    })
                    .await;

                // Update caches
                {
                    let mut rm = state.room_members.write().await;
                    rm.insert(room_id.clone(), vec![user_id.clone(), other_user.clone()]);
                }
                {
                    let mut roles = state.room_roles.write().await;
                    let room_roles = roles.entry(room_id.clone()).or_default();
                    room_roles.insert(user_id.clone(), "owner".to_string());
                    room_roles.insert(other_user.clone(), "member".to_string());
                }

                // Store DM mapping
                let _ = dm_coll
                    .insert_one(DmRoomRecord {
                        user_pair: dm_key,
                        room_id: room_id.clone(),
                    })
                    .await;

                // Broadcast room creation
                let event = json!({
                    "type": "m.room.created",
                    "room_id": room_id,
                    "sender": user_id,
                    "content": {
                        "name": room_name,
                        "is_direct": true
                    }
                });
                broadcast_to_room(&state, &room_id, &event).await;

                return Ok(Json(json!({"room_id": room_id})));
            }
        }
    }

    // Enforce per-user room creation limit (non-DM only)
    if !is_dm {
        let limit = state.server_settings.read().await.room_creation_limit;
        if limit > 0 {
            let count = state
                .db
                .collection::<RoomRecord>("rooms")
                .count_documents(doc! { "creator": &user_id, "is_dm": false })
                .await
                .unwrap_or(0);
            if count >= limit {
                return Err(error_response(
                    StatusCode::FORBIDDEN,
                    &format!("Room creation limit reached (max {})", limit),
                ));
            }
        }
    }

    // Regular room creation
    let room_id = generate_id("!");

    let mut members = vec![user_id.clone()];

    // Add invited users (check they exist)
    if let Some(ref invite_list) = req.invite {
        let users_coll = state
            .db
            .collection::<super::super::state::UserRecord>("users");
        for invited in invite_list {
            if users_coll
                .find_one(doc! { "_id": invited })
                .await
                .ok()
                .flatten()
                .is_some()
                && !members.contains(invited)
            {
                members.push(invited.clone());
            }
        }
    }

    let room_name = if is_dm && members.len() == 2 {
        let other = if members[0] == user_id {
            &members[1]
        } else {
            &members[0]
        };
        let other_display = other
            .split(':')
            .next()
            .unwrap_or(other)
            .trim_start_matches('@');
        format!("DM with {}", other_display)
    } else {
        let room_count = state
            .db
            .collection::<RoomRecord>("rooms")
            .count_documents(doc! {})
            .await
            .unwrap_or(0);
        let raw_name = req.name
            .unwrap_or_else(|| format!("Room {}", room_count + 1));
        let sanitized: String = raw_name.trim().chars().take(18).collect();
        if sanitized.is_empty() {
            return Err(error_response(StatusCode::BAD_REQUEST, "Room name cannot be empty"));
        }
        sanitized
    };

    let password_hash = req.password
        .filter(|p| !p.is_empty())
        .map(|p| hash_password(&p))
        .unwrap_or_default();
    let room_record = RoomRecord {
        room_id: room_id.clone(),
        name: room_name,
        topic: req.topic.unwrap_or_default(),
        creator: user_id.clone(),
        is_dm,
        tags: req.tags.unwrap_or_default(),
        icon_url: req.icon_url.unwrap_or_default(),
        custom_emojis: vec![],
        emoji_aliases: std::collections::HashMap::new(),
        owner_name_color: String::new(),
        mod_name_color: String::new(),
        unlisted: req.unlisted.unwrap_or(false),
        password_hash,
        room_type: req.room_type.unwrap_or_default(),
    };
    let rooms_coll = state.db.collection::<RoomRecord>("rooms");
    let _ = rooms_coll.insert_one(room_record).await;

    // Register DM mapping
    if is_dm && members.len() == 2 {
        let mut key_parts = [members[0].clone(), members[1].clone()];
        key_parts.sort();
        let dm_key = key_parts.join("|");
        let dm_coll = state.db.collection::<DmRoomRecord>("dm_rooms");
        let _ = dm_coll
            .insert_one(DmRoomRecord {
                user_pair: dm_key,
                room_id: room_id.clone(),
            })
            .await;
    }

    // Add members to MongoDB
    let members_coll = state.db.collection::<RoomMemberRecord>("room_members");
    for member in &members {
        let role = if *member == user_id {
            "owner".to_string()
        } else {
            "member".to_string()
        };
        let _ = members_coll
            .insert_one(RoomMemberRecord {
                room_id: room_id.clone(),
                user_id: member.clone(),
                role,
                joined_at: now_millis(),
            })
            .await;
    }

    // Update caches
    {
        let mut rm = state.room_members.write().await;
        rm.insert(room_id.clone(), members.clone());
    }
    {
        let mut roles = state.room_roles.write().await;
        let room_roles = roles.entry(room_id.clone()).or_default();
        for member in &members {
            let role = if *member == user_id { "owner" } else { "member" };
            room_roles.insert(member.clone(), role.to_string());
        }
    }

    Ok(Json(json!({"room_id": room_id})))
}

pub(crate) async fn join_room(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
    body: Option<Json<JoinRoomRequest>>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    // Check room exists in MongoDB
    let rooms_coll = state.db.collection::<RoomRecord>("rooms");
    let room = rooms_coll
        .find_one(doc! { "_id": &room_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Room not found"))?;

    // Check password if room is password-protected
    if !room.password_hash.is_empty() {
        let provided = body.as_ref().and_then(|b| b.password.as_deref()).unwrap_or("");
        if !verify_password(provided, &room.password_hash) {
            return Err(error_response(StatusCode::FORBIDDEN, "Incorrect password"));
        }
    }

    if let Err(msg) = do_join_room(&state, &room_id, &user_id).await {
        return Err(error_response(StatusCode::FORBIDDEN, msg));
    }

    Ok(Json(json!({"room_id": room_id})))
}

pub(crate) async fn leave_room(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let rooms_coll = state.db.collection::<RoomRecord>("rooms");
    if rooms_coll
        .find_one(doc! { "_id": &room_id })
        .await
        .ok()
        .flatten()
        .is_none()
    {
        return Err(error_response(StatusCode::NOT_FOUND, "Room not found"));
    }

    // Remove from MongoDB
    let members_coll = state.db.collection::<RoomMemberRecord>("room_members");
    let delete_result = members_coll
        .delete_one(doc! { "room_id": &room_id, "user_id": &user_id })
        .await;

    let was_member = delete_result
        .map(|r| r.deleted_count > 0)
        .unwrap_or(false);

    // Update caches
    if was_member {
        {
            let mut rm = state.room_members.write().await;
            if let Some(members) = rm.get_mut(&room_id) {
                members.retain(|m| m != &user_id);
            }
        }
        {
            let mut roles = state.room_roles.write().await;
            if let Some(room_roles) = roles.get_mut(&room_id) {
                room_roles.remove(&user_id);
            }
        }

        // Remove from voice channel
        {
            let mut vc = state.voice_channels.write().await;
            if let Some(room_vc) = vc.get_mut(&room_id) {
                room_vc.remove(&user_id);
            }
        }

        let display = user_id
            .split(':')
            .next()
            .unwrap_or(&user_id)
            .trim_start_matches('@');
        let sys_event = json!({
            "type": "m.room.message",
            "room_id": room_id,
            "sender": user_id,
            "content": {
                "msgtype": "m.system",
                "body": format!("{} has left the room", display)
            },
            "event_id": generate_id("$"),
            "origin_server_ts": now_millis()
        });

        // Store system message in MongoDB
        let msg_coll = state.db.collection::<mongodb::bson::Document>("messages");
        if let Ok(doc) = mongodb::bson::to_document(&sys_event) {
            let _ = msg_coll.insert_one(doc).await;
        }
        broadcast_to_room(&state, &room_id, &sys_event).await;

        let event = json!({
            "type": "m.room.member",
            "room_id": room_id,
            "sender": user_id,
            "content": {"membership": "leave"},
            "event_id": generate_id("$"),
            "origin_server_ts": now_millis()
        });
        broadcast_to_room(&state, &room_id, &event).await;
    }

    Ok(Json(json!({"room_id": room_id})))
}

pub(crate) async fn joined_rooms(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    // Use cache for fast lookup
    let rm = state.room_members.read().await;
    let joined: Vec<String> = rm
        .iter()
        .filter(|(_, members)| members.contains(&user_id))
        .map(|(rid, _)| rid.clone())
        .collect();

    Ok(Json(json!({"joined_rooms": joined})))
}

pub(crate) async fn delete_room(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    // Check room exists and user is creator
    let rooms_coll = state.db.collection::<RoomRecord>("rooms");
    let room = rooms_coll
        .find_one(doc! { "_id": &room_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Room not found"))?;

    if room.creator != user_id {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "Only the room creator can delete the room",
        ));
    }

    // Broadcast deletion event before removing
    let event = json!({
        "type": "m.room.deleted",
        "room_id": room_id,
        "sender": user_id,
        "content": {}
    });
    broadcast_to_room(&state, &room_id, &event).await;

    // Remove from MongoDB
    let _ = rooms_coll.delete_one(doc! { "_id": &room_id }).await;
    let members_coll = state.db.collection::<RoomMemberRecord>("room_members");
    let _ = members_coll.delete_many(doc! { "room_id": &room_id }).await;
    let msg_coll = state.db.collection::<mongodb::bson::Document>("messages");
    let _ = msg_coll.delete_many(doc! { "room_id": &room_id }).await;
    let react_coll = state
        .db
        .collection::<super::super::state::ReactionRecord>("reactions");
    // Delete reactions for messages in this room (we'd need event_ids, but simpler to just
    // leave orphaned reactions since they won't be queried)
    let _ = react_coll; // reactions will be orphaned but harmless

    // Remove forum data
    let forum_posts_coll = state
        .db
        .collection::<super::super::state::ForumPostRecord>("forum_posts");
    let _ = forum_posts_coll.delete_many(doc! { "room_id": &room_id }).await;
    let forum_comments_coll = state
        .db
        .collection::<super::super::state::ForumCommentRecord>("forum_comments");
    let _ = forum_comments_coll.delete_many(doc! { "room_id": &room_id }).await;

    // Remove whiteboard data
    let whiteboard_coll = state
        .db
        .collection::<super::super::state::WhiteboardStrokeRecord>("whiteboard_strokes");
    let _ = whiteboard_coll.delete_many(doc! { "room_id": &room_id }).await;

    // Remove DM mapping
    let dm_coll = state.db.collection::<DmRoomRecord>("dm_rooms");
    let _ = dm_coll.delete_many(doc! { "room_id": &room_id }).await;

    // Remove invites
    let inv_coll = state
        .db
        .collection::<super::super::state::InviteRecord>("invites");
    let _ = inv_coll.delete_many(doc! { "room_id": &room_id }).await;

    // Delete banned users for this room
    let banned_coll = state
        .db
        .collection::<super::super::state::BannedUserRecord>("banned_users");
    let _ = banned_coll.delete_many(doc! { "room_id": &room_id }).await;

    // Update caches
    state.room_members.write().await.remove(&room_id);
    state.room_roles.write().await.remove(&room_id);
    state.banned_users.write().await.remove(&room_id);
    state.voice_channels.write().await.remove(&room_id);

    Ok(Json(json!({"deleted": true})))
}

pub(crate) async fn list_all_rooms(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    use futures_util::TryStreamExt;

    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let _user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let rooms_coll = state.db.collection::<RoomRecord>("rooms");
    let rm = state.room_members.read().await;
    let vc = state.voice_channels.read().await;

    let mut room_list: Vec<Value> = Vec::new();

    if let Ok(mut cursor) = rooms_coll.find(doc! { "is_dm": false, "unlisted": { "$ne": true } }).await {
        while let Ok(Some(room)) = cursor.try_next().await {
            let voice_members = vc.get(&room.room_id);
            let voice_count = voice_members.map(|v| v.len()).unwrap_or(0);
            let screen_share_active = voice_members
                .map(|v| v.values().any(|m| m.screen_sharing))
                .unwrap_or(false);
            room_list.push(json!({
                "room_id": room.room_id,
                "name": room.name,
                "topic": room.topic,
                "member_count": rm.get(&room.room_id).map(|m| m.len()).unwrap_or(0),
                "voice_count": voice_count,
                "screen_share_active": screen_share_active,
                "tags": room.tags,
                "icon_url": room.icon_url,
                "has_password": !room.password_hash.is_empty(),
                "room_type": if room.room_type.is_empty() { "text" } else { &room.room_type }
            }));
        }
    }

    Ok(Json(json!({"rooms": room_list})))
}

pub(crate) async fn update_room_topic(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
    Json(req): Json<UpdateTopicRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let rooms_coll = state.db.collection::<RoomRecord>("rooms");
    if rooms_coll
        .find_one(doc! { "_id": &room_id })
        .await
        .ok()
        .flatten()
        .is_none()
    {
        return Err(error_response(StatusCode::NOT_FOUND, "Room not found"));
    }

    // Check membership from cache
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

    // Update topic in MongoDB
    let _ = rooms_coll
        .update_one(
            doc! { "_id": &room_id },
            doc! { "$set": { "topic": &req.topic } },
        )
        .await;

    let event = json!({
        "type": "m.room.topic",
        "room_id": room_id,
        "sender": user_id,
        "content": { "topic": req.topic }
    });
    broadcast_to_room(&state, &room_id, &event).await;

    Ok(Json(json!({"event_id": generate_id("$")})))
}

pub(crate) async fn update_room_settings(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
    Json(req): Json<UpdateRoomSettingsRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let rooms_coll = state.db.collection::<RoomRecord>("rooms");
    let room = rooms_coll
        .find_one(doc! { "_id": &room_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Room not found"))?;

    if room.creator != user_id {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "Only the room creator can edit settings",
        ));
    }

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

    // Build update doc
    let mut set_doc = mongodb::bson::Document::new();
    let mut content = serde_json::Map::new();

    if let Some(ref name) = req.name {
        let sanitized: String = name.trim().chars().take(18).collect();
        if sanitized.is_empty() {
            return Err(error_response(StatusCode::BAD_REQUEST, "Room name cannot be empty"));
        }
        set_doc.insert("name", sanitized.as_str());
        content.insert("name".to_string(), json!(sanitized));
    }
    if let Some(ref icon_url) = req.icon_url {
        set_doc.insert("icon_url", icon_url.as_str());
        content.insert("icon_url".to_string(), json!(icon_url));
    }
    if let Some(ref tags) = req.tags {
        set_doc.insert(
            "tags",
            mongodb::bson::to_bson(tags).unwrap_or(mongodb::bson::Bson::Null),
        );
        content.insert("tags".to_string(), json!(tags));
    }
    if let Some(ref custom_emojis) = req.custom_emojis {
        set_doc.insert(
            "custom_emojis",
            mongodb::bson::to_bson(custom_emojis).unwrap_or(mongodb::bson::Bson::Null),
        );
        content.insert("custom_emojis".to_string(), json!(custom_emojis));
    }
    if let Some(ref emoji_aliases) = req.emoji_aliases {
        set_doc.insert(
            "emoji_aliases",
            mongodb::bson::to_bson(emoji_aliases).unwrap_or(mongodb::bson::Bson::Null),
        );
        content.insert("emoji_aliases".to_string(), json!(emoji_aliases));
    }
    if let Some(unlisted) = req.unlisted {
        set_doc.insert("unlisted", unlisted);
        content.insert("unlisted".to_string(), json!(unlisted));
    }
    if req.remove_password.unwrap_or(false) {
        set_doc.insert("password_hash", "");
        content.insert("has_password".to_string(), json!(false));
    } else if let Some(ref password) = req.password {
        if !password.is_empty() {
            set_doc.insert("password_hash", hash_password(password));
            content.insert("has_password".to_string(), json!(true));
        }
    }

    if !set_doc.is_empty() {
        let _ = rooms_coll
            .update_one(doc! { "_id": &room_id }, doc! { "$set": set_doc })
            .await;
    }

    let event = json!({
        "type": "m.room.settings",
        "room_id": room_id,
        "sender": user_id,
        "content": Value::Object(content)
    });
    broadcast_to_room(&state, &room_id, &event).await;

    Ok(Json(json!({"event_id": generate_id("$")})))
}

// ─── Permissions handlers ────────────────────────────────────────────────────

pub(crate) async fn kick_member(
    State(state): State<Arc<AppState>>,
    Path((room_id, target_user_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let caller_role = get_user_role(&state, &room_id, &user_id).await;
    let target_role = get_user_role(&state, &room_id, &target_user_id).await;

    if caller_role == "member" {
        return Err(error_response(StatusCode::FORBIDDEN, "No permission to kick"));
    }
    if target_role == "owner" {
        return Err(error_response(StatusCode::FORBIDDEN, "Cannot kick the owner"));
    }
    if caller_role == "moderator" && target_role == "moderator" {
        return Err(error_response(StatusCode::FORBIDDEN, "Moderators cannot kick other moderators"));
    }

    let members_coll = state.db.collection::<RoomMemberRecord>("room_members");
    let _ = members_coll
        .delete_one(doc! { "room_id": &room_id, "user_id": &target_user_id })
        .await;

    {
        let mut rm = state.room_members.write().await;
        if let Some(members) = rm.get_mut(&room_id) {
            members.retain(|m| m != &target_user_id);
        }
    }
    {
        let mut roles = state.room_roles.write().await;
        if let Some(room_roles) = roles.get_mut(&room_id) {
            room_roles.remove(&target_user_id);
        }
    }
    {
        let mut vc = state.voice_channels.write().await;
        if let Some(room_vc) = vc.get_mut(&room_id) {
            room_vc.remove(&target_user_id);
        }
    }

    let target_display = target_user_id
        .split(':')
        .next()
        .unwrap_or(&target_user_id)
        .trim_start_matches('@');
    let sys_event = json!({
        "type": "m.room.message",
        "room_id": room_id,
        "sender": user_id,
        "content": {
            "msgtype": "m.system",
            "body": format!("{} was kicked from the room", target_display)
        },
        "event_id": generate_id("$"),
        "origin_server_ts": now_millis()
    });
    let msg_coll = state.db.collection::<mongodb::bson::Document>("messages");
    if let Ok(doc) = mongodb::bson::to_document(&sys_event) {
        let _ = msg_coll.insert_one(doc).await;
    }
    broadcast_to_room(&state, &room_id, &sys_event).await;

    let kick_event = json!({
        "type": "m.room.kick",
        "room_id": room_id,
        "user_id": target_user_id,
        "sender": user_id,
    });
    super::super::helpers::send_to_user(&state, &target_user_id, &kick_event).await;

    let member_event = json!({
        "type": "m.room.member",
        "room_id": room_id,
        "sender": target_user_id,
        "content": {"membership": "leave"},
        "event_id": generate_id("$"),
        "origin_server_ts": now_millis()
    });
    broadcast_to_room(&state, &room_id, &member_event).await;

    Ok(Json(json!({"kicked": true})))
}

pub(crate) async fn ban_member(
    State(state): State<Arc<AppState>>,
    Path((room_id, target_user_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let caller_role = get_user_role(&state, &room_id, &user_id).await;
    let target_role = get_user_role(&state, &room_id, &target_user_id).await;

    if caller_role == "member" {
        return Err(error_response(StatusCode::FORBIDDEN, "No permission to ban"));
    }
    if target_role == "owner" {
        return Err(error_response(StatusCode::FORBIDDEN, "Cannot ban the owner"));
    }
    if caller_role == "moderator" && target_role == "moderator" {
        return Err(error_response(StatusCode::FORBIDDEN, "Moderators cannot ban other moderators"));
    }

    let ban_coll = state.db.collection::<BannedUserRecord>("banned_users");
    let _ = ban_coll
        .insert_one(BannedUserRecord {
            room_id: room_id.clone(),
            user_id: target_user_id.clone(),
            banned_by: user_id.clone(),
            banned_at: now_millis(),
        })
        .await;

    {
        let mut banned = state.banned_users.write().await;
        banned
            .entry(room_id.clone())
            .or_default()
            .push(target_user_id.clone());
    }

    let members_coll = state.db.collection::<RoomMemberRecord>("room_members");
    let _ = members_coll
        .delete_one(doc! { "room_id": &room_id, "user_id": &target_user_id })
        .await;
    {
        let mut rm = state.room_members.write().await;
        if let Some(members) = rm.get_mut(&room_id) {
            members.retain(|m| m != &target_user_id);
        }
    }
    {
        let mut roles = state.room_roles.write().await;
        if let Some(room_roles) = roles.get_mut(&room_id) {
            room_roles.remove(&target_user_id);
        }
    }
    {
        let mut vc = state.voice_channels.write().await;
        if let Some(room_vc) = vc.get_mut(&room_id) {
            room_vc.remove(&target_user_id);
        }
    }

    let target_display = target_user_id
        .split(':')
        .next()
        .unwrap_or(&target_user_id)
        .trim_start_matches('@');
    let sys_event = json!({
        "type": "m.room.message",
        "room_id": room_id,
        "sender": user_id,
        "content": {
            "msgtype": "m.system",
            "body": format!("{} was banned from the room", target_display)
        },
        "event_id": generate_id("$"),
        "origin_server_ts": now_millis()
    });
    let msg_coll = state.db.collection::<mongodb::bson::Document>("messages");
    if let Ok(doc) = mongodb::bson::to_document(&sys_event) {
        let _ = msg_coll.insert_one(doc).await;
    }
    broadcast_to_room(&state, &room_id, &sys_event).await;

    let kick_event = json!({
        "type": "m.room.kick",
        "room_id": room_id,
        "user_id": target_user_id,
        "sender": user_id,
    });
    super::super::helpers::send_to_user(&state, &target_user_id, &kick_event).await;

    let member_event = json!({
        "type": "m.room.member",
        "room_id": room_id,
        "sender": target_user_id,
        "content": {"membership": "leave"},
        "event_id": generate_id("$"),
        "origin_server_ts": now_millis()
    });
    broadcast_to_room(&state, &room_id, &member_event).await;

    Ok(Json(json!({"banned": true})))
}

pub(crate) async fn unban_member(
    State(state): State<Arc<AppState>>,
    Path((room_id, target_user_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let caller_role = get_user_role(&state, &room_id, &user_id).await;
    if caller_role != "owner" && caller_role != "moderator" {
        return Err(error_response(StatusCode::FORBIDDEN, "Only owners and moderators can unban"));
    }

    let ban_coll = state.db.collection::<BannedUserRecord>("banned_users");
    let _ = ban_coll
        .delete_one(doc! { "room_id": &room_id, "user_id": &target_user_id })
        .await;

    {
        let mut banned = state.banned_users.write().await;
        if let Some(list) = banned.get_mut(&room_id) {
            list.retain(|u| u != &target_user_id);
        }
    }

    Ok(Json(json!({"unbanned": true})))
}

pub(crate) async fn set_member_role(
    State(state): State<Arc<AppState>>,
    Path((room_id, target_user_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(req): Json<SetRoleRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let caller_role = get_user_role(&state, &room_id, &user_id).await;
    if caller_role != "owner" {
        return Err(error_response(StatusCode::FORBIDDEN, "Only the owner can change roles"));
    }

    if req.role != "moderator" && req.role != "member" {
        return Err(error_response(StatusCode::BAD_REQUEST, "Role must be 'moderator' or 'member'"));
    }

    let target_role = get_user_role(&state, &room_id, &target_user_id).await;
    if target_role == "owner" {
        return Err(error_response(StatusCode::FORBIDDEN, "Cannot change the owner's role"));
    }

    {
        let rm = state.room_members.read().await;
        if !rm
            .get(&room_id)
            .map(|m| m.contains(&target_user_id))
            .unwrap_or(false)
        {
            return Err(error_response(StatusCode::NOT_FOUND, "User is not a member"));
        }
    }

    let members_coll = state.db.collection::<RoomMemberRecord>("room_members");
    let _ = members_coll
        .update_one(
            doc! { "room_id": &room_id, "user_id": &target_user_id },
            doc! { "$set": { "role": &req.role } },
        )
        .await;

    {
        let mut roles = state.room_roles.write().await;
        roles
            .entry(room_id.clone())
            .or_default()
            .insert(target_user_id.clone(), req.role.clone());
    }

    let target_display = target_user_id
        .split(':')
        .next()
        .unwrap_or(&target_user_id)
        .trim_start_matches('@');
    let action = if req.role == "moderator" {
        "promoted to moderator"
    } else {
        "demoted to member"
    };
    let sys_event = json!({
        "type": "m.room.message",
        "room_id": room_id,
        "sender": user_id,
        "content": {
            "msgtype": "m.system",
            "body": format!("{} was {}", target_display, action)
        },
        "event_id": generate_id("$"),
        "origin_server_ts": now_millis()
    });
    let msg_coll = state.db.collection::<mongodb::bson::Document>("messages");
    if let Ok(doc) = mongodb::bson::to_document(&sys_event) {
        let _ = msg_coll.insert_one(doc).await;
    }
    broadcast_to_room(&state, &room_id, &sys_event).await;

    let role_event = json!({
        "type": "m.room.member_role",
        "room_id": room_id,
        "user_id": target_user_id,
        "role": req.role,
        "sender": user_id,
    });
    broadcast_to_room(&state, &room_id, &role_event).await;

    Ok(Json(json!({"role": req.role})))
}

pub(crate) async fn set_name_colors(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
    Json(req): Json<SetNameColorRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let caller_role = get_user_role(&state, &room_id, &user_id).await;
    if caller_role != "owner" {
        return Err(error_response(StatusCode::FORBIDDEN, "Only the owner can set name colors"));
    }

    let rooms_coll = state.db.collection::<RoomRecord>("rooms");
    let room = rooms_coll
        .find_one(doc! { "_id": &room_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Room not found"))?;

    let final_owner_color = req.owner_color.unwrap_or(room.owner_name_color);
    let final_mod_color = req.mod_color.unwrap_or(room.mod_name_color);

    let _ = rooms_coll
        .update_one(
            doc! { "_id": &room_id },
            doc! { "$set": {
                "owner_name_color": &final_owner_color,
                "mod_name_color": &final_mod_color,
            }},
        )
        .await;

    let event = json!({
        "type": "m.room.name_colors",
        "room_id": room_id,
        "sender": user_id,
        "content": {
            "owner_name_color": final_owner_color,
            "mod_name_color": final_mod_color,
        }
    });
    broadcast_to_room(&state, &room_id, &event).await;

    Ok(Json(json!({"updated": true})))
}

pub(crate) async fn list_banned_users(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let caller_role = get_user_role(&state, &room_id, &user_id).await;
    if caller_role != "owner" && caller_role != "moderator" {
        return Err(error_response(StatusCode::FORBIDDEN, "Only owners and moderators can view bans"));
    }

    let ban_coll = state.db.collection::<BannedUserRecord>("banned_users");
    let mut cursor = ban_coll
        .find(doc! { "room_id": &room_id })
        .await
        .map_err(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "Failed to query bans"))?;

    let mut bans = Vec::new();
    while cursor.advance().await.unwrap_or(false) {
        if let Ok(record) = cursor.deserialize_current() {
            bans.push(json!({
                "user_id": record.user_id,
                "banned_by": record.banned_by,
                "banned_at": record.banned_at,
            }));
        }
    }

    Ok(Json(json!({ "bans": bans })))
}
