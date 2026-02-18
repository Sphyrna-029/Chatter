use super::super::{
    dto::{CreateRoomRequest, UpdateRoomSettingsRequest, UpdateTopicRequest},
    helpers::{
        broadcast_to_room, error_response, extract_token, generate_id, get_user_from_token,
        now_millis,
    },
    state::{AppState, RoomRecord},
};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::Json,
};
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
        .await
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let is_dm = req.is_direct.unwrap_or(false);

    // If it's a DM, check if one already exists
    if is_dm {
        if let Some(invite_list) = &req.invite {
            if invite_list.len() == 1 {
                let other_user = &invite_list[0];

                // Prevent self-DMs
                if *other_user == user_id {
                    return Err(error_response(
                        StatusCode::BAD_REQUEST,
                        "Cannot DM yourself",
                    ));
                }

                // Create sorted key for DM lookup
                let dm_key = if user_id < *other_user {
                    format!("{}|{}", user_id, other_user)
                } else {
                    format!("{}|{}", other_user, user_id)
                };

                // Check if DM already exists
                let dm_rooms = state.dm_rooms.read().await;
                if let Some(existing_room_id) = dm_rooms.get(&dm_key) {
                    let existing_room_id = existing_room_id.clone();
                    drop(dm_rooms);

                    // Re-add the user if they left
                    let mut rm = state.room_members.write().await;
                    if let Some(members) = rm.get_mut(&existing_room_id) {
                        if !members.contains(&user_id) {
                            members.push(user_id.clone());
                            drop(rm);

                            let display = user_id
                                .split(':')
                                .next()
                                .unwrap_or(&user_id)
                                .trim_start_matches('@');
                            let sys_event = json!({
                                "type": "m.room.message",
                                "room_id": existing_room_id,
                                "sender": user_id,
                                "content": {
                                    "msgtype": "m.system",
                                    "body": format!("{} has joined the room", display)
                                },
                                "event_id": generate_id("$"),
                                "origin_server_ts": now_millis()
                            });
                            state
                                .messages
                                .write()
                                .await
                                .entry(existing_room_id.clone())
                                .or_insert_with(Vec::new)
                                .push(sys_event.clone());
                            broadcast_to_room(&state, &existing_room_id, &sys_event).await;

                            let event = json!({
                                "type": "m.room.member",
                                "room_id": existing_room_id,
                                "sender": user_id,
                                "content": {"membership": "join"},
                                "event_id": generate_id("$"),
                                "origin_server_ts": now_millis()
                            });
                            broadcast_to_room(&state, &existing_room_id, &event).await;
                        }
                    }

                    return Ok(Json(json!({"room_id": existing_room_id})));
                }
                drop(dm_rooms);

                // Create new DM room
                let room_id = generate_id("!");
                let other_user_name = other_user
                    .split(':')
                    .next()
                    .unwrap_or(other_user)
                    .trim_start_matches('@');
                let room_name = format!("DM with {}", other_user_name);

                state.rooms.write().await.insert(
                    room_id.clone(),
                    RoomRecord {
                        name: room_name.clone(),
                        topic: String::from("Direct Message"),
                        creator: user_id.clone(),
                        is_dm: true,
                        tags: vec![],
                        icon_url: String::new(),
                        custom_emojis: vec![],
                    },
                );

                let members = vec![user_id.clone(), other_user.clone()];

                state
                    .room_members
                    .write()
                    .await
                    .insert(room_id.clone(), members);
                state
                    .messages
                    .write()
                    .await
                    .insert(room_id.clone(), Vec::new());

                // Store DM mapping
                state.dm_rooms.write().await.insert(dm_key, room_id.clone());

                // Broadcast room creation so the invited user sees it in real-time
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

    // Regular room creation
    let room_id = generate_id("!");
    let room_count = state.rooms.read().await.len();

    let mut members = vec![user_id.clone()];

    // Add invited users
    if let Some(ref invite_list) = req.invite {
        let users = state.users.read().await;
        for invited in invite_list {
            if users.contains_key(invited) && !members.contains(invited) {
                members.push(invited.clone());
            }
        }
    }

    let room_name = if is_dm && members.len() == 2 {
        // Name DM after the other user
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
        req.name
            .unwrap_or_else(|| format!("Room {}", room_count + 1))
    };

    state.rooms.write().await.insert(
        room_id.clone(),
        RoomRecord {
            name: room_name,
            topic: req.topic.unwrap_or_default(),
            creator: user_id.clone(),
            is_dm: false,
            tags: req.tags.unwrap_or_default(),
            icon_url: req.icon_url.unwrap_or_default(),
            custom_emojis: vec![],
        },
    );

    // Register DM mapping
    if is_dm && members.len() == 2 {
        let mut key_parts = [members[0].clone(), members[1].clone()];
        key_parts.sort();
        let dm_key = key_parts.join("|");
        state.dm_rooms.write().await.insert(dm_key, room_id.clone());
    }

    state
        .room_members
        .write()
        .await
        .insert(room_id.clone(), members);
    state
        .messages
        .write()
        .await
        .insert(room_id.clone(), Vec::new());

    Ok(Json(json!({"room_id": room_id})))
}

pub(crate) async fn join_room(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .await
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    if !state.rooms.read().await.contains_key(&room_id) {
        return Err(error_response(StatusCode::NOT_FOUND, "Room not found"));
    }

    let mut rm = state.room_members.write().await;
    let members = rm.entry(room_id.clone()).or_insert_with(Vec::new);

    let need_broadcast = !members.contains(&user_id);
    if need_broadcast {
        members.push(user_id.clone());
    }
    drop(rm);

    if need_broadcast {
        let event = json!({
            "type": "m.room.member",
            "room_id": room_id,
            "sender": user_id,
            "content": {"membership": "join"},
            "event_id": generate_id("$"),
            "origin_server_ts": now_millis()
        });
        broadcast_to_room(&state, &room_id, &event).await;

        // System message for the join
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
                "body": format!("{} has joined the room", display)
            },
            "event_id": generate_id("$"),
            "origin_server_ts": now_millis()
        });
        state
            .messages
            .write()
            .await
            .entry(room_id.clone())
            .or_insert_with(Vec::new)
            .push(sys_event.clone());
        broadcast_to_room(&state, &room_id, &sys_event).await;
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
        .await
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    if !state.rooms.read().await.contains_key(&room_id) {
        return Err(error_response(StatusCode::NOT_FOUND, "Room not found"));
    }

    let was_member = {
        let mut rm = state.room_members.write().await;
        if let Some(members) = rm.get_mut(&room_id) {
            if let Some(pos) = members.iter().position(|m| m == &user_id) {
                members.remove(pos);
                true
            } else {
                false
            }
        } else {
            false
        }
    };

    if was_member {
        // Remove from voice channel
        {
            let mut vc = state.voice_channels.write().await;
            if let Some(room_vc) = vc.get_mut(&room_id) {
                room_vc.remove(&user_id);
            }
        }

        // System message for the leave (store before broadcasting member event,
        // so remaining members AND the leaving user's last fetch both include it)
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
        state
            .messages
            .write()
            .await
            .entry(room_id.clone())
            .or_insert_with(Vec::new)
            .push(sys_event.clone());
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
        .await
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let rm = state.room_members.read().await;
    let joined: Vec<String> = rm
        .iter()
        .filter(|(_, members)| members.contains(&user_id))
        .map(|(rid, _)| rid.clone())
        .collect();

    Ok(Json(json!({"joined_rooms": joined})))
}

pub(crate) async fn list_all_rooms(State(state): State<Arc<AppState>>) -> Json<Value> {
    let rooms = state.rooms.read().await;
    let rm = state.room_members.read().await;
    let vc = state.voice_channels.read().await;

    let room_list: Vec<Value> = rooms
        .iter()
        .filter(|(_, room)| !room.is_dm) // Don't include DMs in public room list
        .map(|(room_id, room)| {
            let voice_members = vc.get(room_id);
            let voice_count = voice_members.map(|v| v.len()).unwrap_or(0);
            let screen_share_active = voice_members
                .map(|v| v.values().any(|m| m.screen_sharing))
                .unwrap_or(false);
            json!({
                "room_id": room_id,
                "name": room.name,
                "topic": room.topic,
                "member_count": rm.get(room_id).map(|m| m.len()).unwrap_or(0),
                "voice_count": voice_count,
                "screen_share_active": screen_share_active,
                "tags": room.tags,
                "icon_url": room.icon_url
            })
        })
        .collect();

    Json(json!({"rooms": room_list}))
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

pub(crate) async fn update_room_topic(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
    Json(req): Json<UpdateTopicRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .await
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    // Check room exists and user is a member
    {
        let rooms = state.rooms.read().await;
        if !rooms.contains_key(&room_id) {
            return Err(error_response(StatusCode::NOT_FOUND, "Room not found"));
        }
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

    // Update topic
    {
        let mut rooms = state.rooms.write().await;
        if let Some(room) = rooms.get_mut(&room_id) {
            room.topic = req.topic.clone();
        }
    }

    // Broadcast to room
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
        .await
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    // Check room exists and user is creator
    {
        let rooms = state.rooms.read().await;
        let room = rooms
            .get(&room_id)
            .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Room not found"))?;
        if room.creator != user_id {
            return Err(error_response(
                StatusCode::FORBIDDEN,
                "Only the room creator can edit settings",
            ));
        }
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

    // Update fields
    let mut updated_name = None;
    let mut updated_icon_url = None;
    let mut updated_tags = None;
    let mut updated_custom_emojis = None;
    {
        let mut rooms = state.rooms.write().await;
        if let Some(room) = rooms.get_mut(&room_id) {
            if let Some(ref name) = req.name {
                room.name = name.clone();
                updated_name = Some(name.clone());
            }
            if let Some(ref icon_url) = req.icon_url {
                room.icon_url = icon_url.clone();
                updated_icon_url = Some(icon_url.clone());
            }
            if let Some(ref tags) = req.tags {
                room.tags = tags.clone();
                updated_tags = Some(tags.clone());
            }
            if let Some(ref custom_emojis) = req.custom_emojis {
                room.custom_emojis = custom_emojis.clone();
                updated_custom_emojis = Some(custom_emojis.clone());
            }
        }
    }

    // Build broadcast content with only changed fields
    let mut content = serde_json::Map::new();
    if let Some(name) = updated_name {
        content.insert("name".to_string(), json!(name));
    }
    if let Some(icon_url) = updated_icon_url {
        content.insert("icon_url".to_string(), json!(icon_url));
    }
    if let Some(tags) = updated_tags {
        content.insert("tags".to_string(), json!(tags));
    }
    if let Some(custom_emojis) = updated_custom_emojis {
        content.insert("custom_emojis".to_string(), json!(custom_emojis));
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
