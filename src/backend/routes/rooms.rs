use super::super::{
    audit,
    dto::{
        AddToDmRequest, CreateRoomRequest, JoinRoomRequest, SetNameColorRequest, SetRoleRequest,
        UpdateRoomSettingsRequest, UpdateTopicRequest,
    },
    helpers::{
        broadcast_to_room, do_join_room, effective_permissions, error_response, extract_token,
        generate_id, get_system_channel_id, get_user_from_token, get_user_role, hash_password,
        is_blocked_between, now_millis, send_to_user, verify_password,
    },
    state::{
        AppState, BannedUserRecord, ChannelRecord, DmRoomRecord, RoomMemberRecord, RoomRecord,
        UserRecord,
    },
};
use super::channels::ensure_default_channels;
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
            if invite_list.is_empty() {
                return Err(error_response(
                    StatusCode::BAD_REQUEST,
                    "Cannot create DM with no users",
                ));
            }
            if invite_list.len() > 19 {
                return Err(error_response(
                    StatusCode::BAD_REQUEST,
                    "Group DMs support at most 20 members",
                ));
            }

            if invite_list.len() >= 2 {
                // Group DM creation (2–19 invitees, 20 members total including creator)
                if invite_list.contains(&user_id) {
                    return Err(error_response(
                        StatusCode::BAD_REQUEST,
                        "Cannot DM yourself",
                    ));
                }

                let users_coll = state.db.collection::<UserRecord>("users");
                let mut valid_invites: Vec<String> = Vec::new();
                for invited in invite_list {
                    // A block keeps someone out of a group DM with the person
                    // who blocked them, the same as a one-to-one.
                    if is_blocked_between(&state, &user_id, invited).await {
                        continue;
                    }
                    if users_coll
                        .find_one(doc! { "_id": invited })
                        .await
                        .ok()
                        .flatten()
                        .is_some()
                        && !valid_invites.contains(invited)
                    {
                        valid_invites.push(invited.clone());
                    }
                }

                let room_id = generate_id("!");
                let room_record = RoomRecord {
                    room_id: room_id.clone(),
                    name: "Group DM".to_string(),
                    topic: "Group Direct Message".to_string(),
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
                    read_only: false,
                    banner_url: String::new(),
                    dm_name_override: false,
                    sounds: std::collections::HashMap::new(),
                    entrance_sounds_enabled: true,
                };
                let rooms_coll = state.db.collection::<RoomRecord>("rooms");
                let _ = rooms_coll.insert_one(room_record).await;

                let members_coll = state.db.collection::<RoomMemberRecord>("room_members");
                let ts = now_millis();
                let mut all_members = vec![user_id.clone()];
                all_members.extend(valid_invites);

                for member in &all_members {
                    let role = if *member == user_id {
                        "owner"
                    } else {
                        "member"
                    };
                    let _ = members_coll
                        .insert_one(RoomMemberRecord {
                            room_id: room_id.clone(),
                            user_id: member.clone(),
                            role: role.to_string(),
                            joined_at: ts,
                        })
                        .await;
                }

                {
                    let mut rm = state.room_members.write().await;
                    rm.insert(room_id.clone(), all_members.clone());
                }
                {
                    let mut roles = state.room_roles.write().await;
                    let room_roles = roles.entry(room_id.clone()).or_default();
                    for member in &all_members {
                        let role = if *member == user_id {
                            "owner"
                        } else {
                            "member"
                        };
                        room_roles.insert(member.clone(), role.to_string());
                    }
                }

                let event = json!({
                    "type": "m.room.created",
                    "room_id": room_id,
                    "sender": user_id,
                    "content": { "is_direct": true }
                });
                broadcast_to_room(&state, &room_id, &event).await;

                return Ok(Json(json!({"room_id": room_id})));
            }

            if invite_list.len() == 1 {
                let other_user = &invite_list[0];

                if *other_user == user_id {
                    return Err(error_response(
                        StatusCode::BAD_REQUEST,
                        "Cannot DM yourself",
                    ));
                }

                // Blocking has to stop the conversation starting, not just the
                // friend request. Until now it did neither: nothing outside
                // friends.rs ever read the blocks collection.
                if is_blocked_between(&state, &user_id, other_user).await {
                    return Err(error_response(
                        StatusCode::FORBIDDEN,
                        "You cannot start a conversation with this user",
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
                    read_only: false,
                    banner_url: String::new(),
                    dm_name_override: false,
                    sounds: std::collections::HashMap::new(),
                    entrance_sounds_enabled: true,
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

    // Enforce room creation disabled (non-DM only, admins bypass)
    if !is_dm {
        let settings = state.server_settings.read().await;
        if settings.room_creation_disabled {
            drop(settings);
            let is_admin = state
                .db
                .collection::<UserRecord>("users")
                .find_one(doc! { "_id": &user_id })
                .await
                .ok()
                .flatten()
                .map(|u| u.is_admin)
                .unwrap_or(false);
            if !is_admin {
                return Err(error_response(
                    StatusCode::FORBIDDEN,
                    "Room creation has been disabled by the server owner",
                ));
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
        let raw_name = req
            .name
            .unwrap_or_else(|| format!("Room {}", room_count + 1));
        let sanitized: String = raw_name.trim().chars().take(64).collect();
        if sanitized.is_empty() {
            return Err(error_response(
                StatusCode::BAD_REQUEST,
                "Room name cannot be empty",
            ));
        }
        sanitized
    };

    let password_hash = req
        .password
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
        read_only: false,
        banner_url: String::new(),
        dm_name_override: false,
        sounds: std::collections::HashMap::new(),
        entrance_sounds_enabled: true,
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
            let role = if *member == user_id {
                "owner"
            } else {
                "member"
            };
            room_roles.insert(member.clone(), role.to_string());
        }
    }

    // Create default channels for non-DM rooms
    if !is_dm {
        ensure_default_channels(&state, &room_id, &user_id).await;
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
        let provided = body
            .as_ref()
            .and_then(|b| b.password.as_deref())
            .unwrap_or("");
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

    // If the leaving user is the owner and other members remain, promote a
    // successor so the room is never left without an owner.
    let leaving_role = get_user_role(&state, &room_id, &user_id).await;
    if leaving_role == "owner" {
        let other_members: Vec<String> = {
            let rm = state.room_members.read().await;
            rm.get(&room_id)
                .map(|m| m.iter().filter(|id| **id != user_id).cloned().collect())
                .unwrap_or_default()
        };

        if !other_members.is_empty() {
            // Prefer an existing moderator; fall back to alphabetically first member
            // for determinism.
            let successor = {
                let roles = state.room_roles.read().await;
                let room_roles = roles.get(&room_id);
                let mod_pick = room_roles.and_then(|rr| {
                    other_members
                        .iter()
                        .find(|id| rr.get(*id).map(|r| r == "moderator").unwrap_or(false))
                        .cloned()
                });
                mod_pick.unwrap_or_else(|| {
                    let mut sorted = other_members.clone();
                    sorted.sort();
                    sorted.into_iter().next().unwrap()
                })
            };

            // Promote successor: update rooms.creator, room_members record, and cache
            let _ = rooms_coll
                .update_one(
                    doc! { "_id": &room_id },
                    doc! { "$set": { "creator": &successor } },
                )
                .await;
            let members_coll_inner = state.db.collection::<RoomMemberRecord>("room_members");
            let _ = members_coll_inner
                .update_one(
                    doc! { "room_id": &room_id, "user_id": &successor },
                    doc! { "$set": { "role": "owner" } },
                )
                .await;
            {
                let mut roles_w = state.room_roles.write().await;
                roles_w
                    .entry(room_id.clone())
                    .or_default()
                    .insert(successor.clone(), "owner".to_string());
            }

            let successor_display = successor
                .split(':')
                .next()
                .unwrap_or(&successor)
                .trim_start_matches('@');
            let transfer_event = json!({
                "type": "m.room.member_role",
                "room_id": room_id,
                "user_id": successor,
                "role": "owner",
            });
            broadcast_to_room(&state, &room_id, &transfer_event).await;
            let mut sys = json!({
                "type": "m.room.message",
                "room_id": room_id,
                "sender": user_id,
                "content": {
                    "msgtype": "m.system",
                    "body": format!("Ownership transferred to {}", successor_display)
                },
                "event_id": generate_id("$"),
                "origin_server_ts": now_millis()
            });
            if let Some(sys_ch) = get_system_channel_id(&state, &room_id).await {
                sys["channel_id"] = json!(sys_ch);
            }
            let msg_coll = state.db.collection::<mongodb::bson::Document>("messages");
            if let Ok(bson_doc) = mongodb::bson::to_document(&sys) {
                let _ = msg_coll.insert_one(bson_doc).await;
            }
            broadcast_to_room(&state, &room_id, &sys).await;
        }
    }

    // Remove from MongoDB
    let members_coll = state.db.collection::<RoomMemberRecord>("room_members");
    let delete_result = members_coll
        .delete_one(doc! { "room_id": &room_id, "user_id": &user_id })
        .await;

    let was_member = delete_result.map(|r| r.deleted_count > 0).unwrap_or(false);

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

        // Remove from voice channels (keyed by channel_id)
        {
            let mut vc = state.voice_channels.write().await;
            for members in vc.values_mut() {
                members.remove(&user_id);
            }
        }

        let display = user_id
            .split(':')
            .next()
            .unwrap_or(&user_id)
            .trim_start_matches('@');
        let mut sys_event = json!({
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
        if let Some(sys_ch) = get_system_channel_id(&state, &room_id).await {
            sys_event["channel_id"] = json!(sys_ch);
        }

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

    // Collect what the room's messages referred to before deleting them: once
    // they are gone there is nothing left saying which files were theirs.
    use futures_util::TryStreamExt;
    let mut attachments: Vec<String> = Vec::new();
    if let Ok(mut cursor) = msg_coll
        .find(doc! { "room_id": &room_id, "content.body": { "$regex": "/external/" } })
        .await
    {
        while let Ok(Some(message)) = cursor.try_next().await {
            if let Ok(body) = message
                .get_document("content")
                .and_then(|c| c.get_str("body"))
            {
                attachments.extend(super::media::attachment_urls(body));
            }
        }
    }

    let _ = msg_coll.delete_many(doc! { "room_id": &room_id }).await;

    // After the messages are gone, so anything still referenced elsewhere is
    // correctly left alone.
    if !attachments.is_empty() {
        attachments.sort();
        attachments.dedup();
        super::media::purge_attachments(&state, &attachments, None, None).await;
    }
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
    let _ = forum_posts_coll
        .delete_many(doc! { "room_id": &room_id })
        .await;
    let forum_comments_coll = state
        .db
        .collection::<super::super::state::ForumCommentRecord>("forum_comments");
    let _ = forum_comments_coll
        .delete_many(doc! { "room_id": &room_id })
        .await;

    // Remove whiteboard data
    let whiteboard_coll = state
        .db
        .collection::<super::super::state::WhiteboardStrokeRecord>("whiteboard_strokes");
    let _ = whiteboard_coll
        .delete_many(doc! { "room_id": &room_id })
        .await;

    // Remove channels
    let channels_coll = state.db.collection::<ChannelRecord>("channels");
    let _ = channels_coll
        .delete_many(doc! { "room_id": &room_id })
        .await;

    // Remove pinned messages
    let pins_coll = state
        .db
        .collection::<super::super::state::PinRecord>("pins");
    let _ = pins_coll.delete_many(doc! { "room_id": &room_id }).await;

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

    if let Ok(mut cursor) = rooms_coll
        .find(doc! { "is_dm": false, "unlisted": { "$ne": true } })
        .await
    {
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
                "banner_url": room.banner_url,
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

    if room.is_dm {
        // For DMs: any member may rename; no other settings are editable
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
        let has_non_name = req.icon_url.is_some()
            || req.tags.is_some()
            || req.custom_emojis.is_some()
            || req.emoji_aliases.is_some()
            || req.unlisted.is_some()
            || req.password.is_some()
            || req.remove_password.is_some()
            || req.read_only.is_some()
            || req.banner_url.is_some()
            || req.sounds.is_some()
            || req.entrance_sounds_enabled.is_some();
        if has_non_name {
            return Err(error_response(
                StatusCode::FORBIDDEN,
                "Only the name can be changed for DM rooms",
            ));
        }
    } else {
        // SECURITY: use get_user_role (which gates on membership) rather than checking
        // room.creator directly.  An ex-member who created the room must not be able
        // to update settings after leaving.
        let caller_role = get_user_role(&state, &room_id, &user_id).await;
        let perms = effective_permissions(&state, &room_id, &user_id).await;

        // A request that only touches the emoji set is allowed by manage_emojis
        // alone; anything else needs manage_channels.
        let emoji_only = req.name.is_none()
            && req.icon_url.is_none()
            && req.tags.is_none()
            && req.unlisted.is_none()
            && req.password.is_none()
            && req.remove_password.is_none()
            && req.read_only.is_none()
            && req.banner_url.is_none()
            && req.sounds.is_none()
            && req.entrance_sounds_enabled.is_none()
            && (req.custom_emojis.is_some() || req.emoji_aliases.is_some());

        let allowed = if emoji_only {
            perms.manage_emojis || perms.manage_channels
        } else {
            perms.manage_channels
        };
        if !allowed {
            return Err(error_response(
                StatusCode::FORBIDDEN,
                "You do not have permission to edit this room's settings",
            ));
        }

        let is_owner = caller_role == "owner";
        let is_mod = caller_role == "moderator";

        // Moderators may only toggle read_only; any other field requires owner
        if is_mod && !is_owner {
            let has_non_read_only = req.name.is_some()
                || req.icon_url.is_some()
                || req.tags.is_some()
                || req.custom_emojis.is_some()
                || req.emoji_aliases.is_some()
                || req.unlisted.is_some()
                || req.password.is_some()
                || req.remove_password.is_some();
            if has_non_read_only {
                return Err(error_response(
                    StatusCode::FORBIDDEN,
                    "Moderators can only change the read-only setting",
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
    }

    // Build update doc
    let mut set_doc = mongodb::bson::Document::new();
    let mut content = serde_json::Map::new();

    if let Some(ref name) = req.name {
        let sanitized: String = name.trim().chars().take(64).collect();
        if sanitized.is_empty() {
            return Err(error_response(
                StatusCode::BAD_REQUEST,
                "Room name cannot be empty",
            ));
        }
        set_doc.insert("name", sanitized.as_str());
        content.insert("name".to_string(), json!(sanitized));
        // For DM rooms, mark that a custom name has been set so sync won't auto-generate
        if room.is_dm {
            set_doc.insert("dm_name_override", true);
        }
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
    if let Some(read_only) = req.read_only {
        set_doc.insert("read_only", read_only);
        content.insert("read_only".to_string(), json!(read_only));
    }
    if let Some(ref sounds) = req.sounds {
        // Only the events the client actually plays are storable, and each
        // chosen file is checked here rather than trusted — a sound plays
        // without anyone asking for it, so its length is not the client's
        // call to make.
        let mut cleaned: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();
        for (event, url) in sounds {
            if !crate::backend::sounds::PACK_EVENTS.contains(&event.as_str()) {
                return Err(error_response(
                    StatusCode::BAD_REQUEST,
                    &format!("Unknown sound event: {event}"),
                ));
            }
            if let Err(err) = crate::backend::sounds::validate_sound_url(&state, url).await {
                return Err(error_response(StatusCode::BAD_REQUEST, &err.message()));
            }
            // An empty URL clears the override back to the built-in sound
            // rather than storing a blank one.
            if !url.trim().is_empty() {
                cleaned.insert(event.clone(), url.trim().to_string());
            }
        }
        set_doc.insert(
            "sounds",
            mongodb::bson::to_bson(&cleaned).unwrap_or(mongodb::bson::Bson::Null),
        );
        content.insert("sounds".to_string(), json!(cleaned));
    }
    if let Some(enabled) = req.entrance_sounds_enabled {
        set_doc.insert("entrance_sounds_enabled", enabled);
        content.insert("entrance_sounds_enabled".to_string(), json!(enabled));
    }
    if let Some(ref banner_url) = req.banner_url {
        set_doc.insert("banner_url", banner_url.as_str());
        content.insert("banner_url".to_string(), json!(banner_url));
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

    let mut changed: Vec<&str> = event["content"]
        .as_object()
        .map(|o| o.keys().map(String::as_str).collect())
        .unwrap_or_default();
    changed.sort_unstable();
    if !changed.is_empty() {
        audit::record(
            &state,
            &room_id,
            &user_id,
            audit::AuditAction::RoomSettingsUpdated,
            &room_id,
            &format!("changed: {}", changed.join(", ")),
        )
        .await;
    }

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

    // Require the caller to be an active room member before checking their role.
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

    let caller_role = get_user_role(&state, &room_id, &user_id).await;
    let target_role = get_user_role(&state, &room_id, &target_user_id).await;

    if !effective_permissions(&state, &room_id, &user_id)
        .await
        .kick_members
    {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "You do not have permission to kick members in this room",
        ));
    }
    // Hierarchy still applies on top of the permission: a role can grant the
    // ability without granting it over everyone.
    if target_role == "owner" {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "Cannot kick the owner",
        ));
    }
    if caller_role == "moderator" && target_role == "moderator" {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "Moderators cannot kick other moderators",
        ));
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
        for members in vc.values_mut() {
            members.remove(&target_user_id);
        }
    }

    let target_display = target_user_id
        .split(':')
        .next()
        .unwrap_or(&target_user_id)
        .trim_start_matches('@');
    let mut sys_event = json!({
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
    if let Some(sys_ch) = get_system_channel_id(&state, &room_id).await {
        sys_event["channel_id"] = json!(sys_ch);
    }
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

    audit::record(
        &state,
        &room_id,
        &user_id,
        audit::AuditAction::MemberKicked,
        &target_user_id,
        "",
    )
    .await;

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

    // Require the caller to be an active room member before checking their role.
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

    let caller_role = get_user_role(&state, &room_id, &user_id).await;
    let target_role = get_user_role(&state, &room_id, &target_user_id).await;

    if !effective_permissions(&state, &room_id, &user_id)
        .await
        .ban_members
    {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "You do not have permission to ban members in this room",
        ));
    }
    // Hierarchy still applies on top of the permission: a role can grant the
    // ability without granting it over everyone.
    if target_role == "owner" {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "Cannot ban the owner",
        ));
    }
    if caller_role == "moderator" && target_role == "moderator" {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "Moderators cannot ban other moderators",
        ));
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
        for members in vc.values_mut() {
            members.remove(&target_user_id);
        }
    }

    let target_display = target_user_id
        .split(':')
        .next()
        .unwrap_or(&target_user_id)
        .trim_start_matches('@');
    let mut sys_event = json!({
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
    if let Some(sys_ch) = get_system_channel_id(&state, &room_id).await {
        sys_event["channel_id"] = json!(sys_ch);
    }
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

    audit::record(
        &state,
        &room_id,
        &user_id,
        audit::AuditAction::MemberBanned,
        &target_user_id,
        "",
    )
    .await;

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

    if !effective_permissions(&state, &room_id, &user_id)
        .await
        .ban_members
    {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "You do not have permission to unban members in this room",
        ));
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

    audit::record(
        &state,
        &room_id,
        &user_id,
        audit::AuditAction::MemberUnbanned,
        &target_user_id,
        "",
    )
    .await;

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
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "Only the owner can change roles",
        ));
    }

    if req.role != "moderator" && req.role != "member" {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "Role must be 'moderator' or 'member'",
        ));
    }

    let target_role = get_user_role(&state, &room_id, &target_user_id).await;
    if target_role == "owner" {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "Cannot change the owner's role",
        ));
    }

    {
        let rm = state.room_members.read().await;
        if !rm
            .get(&room_id)
            .map(|m| m.contains(&target_user_id))
            .unwrap_or(false)
        {
            return Err(error_response(
                StatusCode::NOT_FOUND,
                "User is not a member",
            ));
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
    let mut sys_event = json!({
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
    if let Some(sys_ch) = get_system_channel_id(&state, &room_id).await {
        sys_event["channel_id"] = json!(sys_ch);
    }
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

    audit::record(
        &state,
        &room_id,
        &user_id,
        audit::AuditAction::MemberRoleChanged,
        &target_user_id,
        &format!("role set to {}", req.role),
    )
    .await;

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
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "Only the owner can set name colors",
        ));
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

    if !effective_permissions(&state, &room_id, &user_id)
        .await
        .ban_members
    {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "You do not have permission to view bans in this room",
        ));
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

pub(crate) async fn add_to_dm(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
    Json(req): Json<AddToDmRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    // Verify room exists and is a DM
    let rooms_coll = state.db.collection::<RoomRecord>("rooms");
    let room = rooms_coll
        .find_one(doc! { "_id": &room_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Room not found"))?;

    if !room.is_dm {
        return Err(error_response(StatusCode::BAD_REQUEST, "Room is not a DM"));
    }

    // Requester must be a member
    let is_member = {
        let rm = state.room_members.read().await;
        rm.get(&room_id)
            .map(|m| m.contains(&user_id))
            .unwrap_or(false)
    };
    if !is_member {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "Not a member of this room",
        ));
    }

    // Enforce 20-member cap
    let current_count = {
        let rm = state.room_members.read().await;
        rm.get(&room_id).map(|m| m.len()).unwrap_or(0)
    };
    if current_count >= 20 {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "Group DMs support at most 20 members",
        ));
    }

    // Target user must exist
    let users_coll = state.db.collection::<UserRecord>("users");
    if users_coll
        .find_one(doc! { "_id": &req.user_id })
        .await
        .ok()
        .flatten()
        .is_none()
    {
        return Err(error_response(StatusCode::NOT_FOUND, "User not found"));
    }

    // Nor may someone be added to a DM alongside anyone they have blocked, or
    // who has blocked them — being added by a third party would otherwise be a
    // way around it.
    let existing_members: Vec<String> = {
        let rm = state.room_members.read().await;
        rm.get(&room_id).cloned().unwrap_or_default()
    };
    for member in &existing_members {
        if is_blocked_between(&state, member, &req.user_id).await {
            return Err(error_response(
                StatusCode::FORBIDDEN,
                "That user cannot be added to this conversation",
            ));
        }
    }

    // Add user (do_join_room handles already-member and broadcasts m.room.member)
    match do_join_room(&state, &room_id, &req.user_id).await {
        Ok(false) => {
            return Err(error_response(
                StatusCode::BAD_REQUEST,
                "User is already a member",
            ))
        }
        Err(msg) => return Err(error_response(StatusCode::FORBIDDEN, msg)),
        Ok(true) => {}
    }

    // Notify the new member so their frontend picks up the room immediately
    let event = json!({
        "type": "m.room.created",
        "room_id": room_id,
        "sender": user_id,
        "content": { "is_direct": true }
    });
    send_to_user(&state, &req.user_id, &event).await;

    Ok(Json(json!({ "added": true })))
}
