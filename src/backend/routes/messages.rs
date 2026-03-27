use super::super::{
    dto::{EditMessageRequest, MessagesQuery, SearchQuery, SendMessageRequest, SetThreadNameRequest, ThreadListQuery},
    helpers::{
        babble_text_for_event, broadcast_babble_message, broadcast_to_room, error_response,
        extract_token, generate_id, get_reactions_for_events, get_thread_counts_for_events,
        get_user_from_token, get_user_role, get_user_custom_role_ids, is_moderator_or_owner,
        now_millis, send_to_user,
    },
    state::{AppState, ChannelRecord, RoomRecord},
};
use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::Json,
};
use futures_util::TryStreamExt;
use mongodb::bson::doc;
use regex::Regex;
use serde_json::{json, Value};
use std::sync::Arc;

pub(crate) async fn send_message(
    State(state): State<Arc<AppState>>,
    Path((room_id, txn_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(req): Json<SendMessageRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let _ = txn_id;
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

    if room.read_only {
        let role = get_user_role(&state, &room_id, &user_id).await;
        if role != "owner" && role != "moderator" {
            return Err(error_response(
                StatusCode::FORBIDDEN,
                "This room is read-only",
            ));
        }
    }

    const MAX_MESSAGE_LENGTH: usize = 4000;
    let msgtype = req.msgtype.as_deref().unwrap_or("m.text");
    // Count display length: each :emoji{url}: marker counts as 1 character
    let emoji_marker = regex::Regex::new(r":emoji\{[^}]+\}:").unwrap();
    let display_body = emoji_marker.replace_all(&req.body, "X");
    if msgtype == "m.text" && display_body.len() > MAX_MESSAGE_LENGTH {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "Message exceeds maximum length of 4000 characters",
        ));
    }

    // Resolve channel_id: use provided or fall back to default text channel
    let channel_id = if let Some(cid) = req.channel_id.as_deref() {
        cid.to_string()
    } else if !room.is_dm {
        // Find the default (first) text channel
        use super::channels::ensure_default_channels;
        ensure_default_channels(&state, &room_id, &user_id).await
    } else {
        String::new()
    };

    // Check per-channel permissions
    if !channel_id.is_empty() {
        let channels_coll = state.db.collection::<ChannelRecord>("channels");
        if let Ok(Some(ch)) = channels_coll.find_one(mongodb::bson::doc! { "_id": &channel_id }).await {
            let role = get_user_role(&state, &room_id, &user_id).await;
            let is_privileged = role == "owner" || role == "moderator";

            if ch.read_only && !is_privileged {
                return Err(error_response(
                    StatusCode::FORBIDDEN,
                    "This channel is read-only",
                ));
            }

            // Check view_roles: user must be able to see the channel to send messages
            if !ch.view_roles.is_empty() && !is_privileged {
                let user_roles = get_user_custom_role_ids(&state, &room_id, &user_id).await;
                if !ch.view_roles.iter().any(|r| user_roles.contains(r)) {
                    return Err(error_response(
                        StatusCode::FORBIDDEN,
                        "You do not have access to this channel",
                    ));
                }
            }

            // Check write_roles: if set, only those roles can send
            if !ch.write_roles.is_empty() && !is_privileged {
                let user_roles = get_user_custom_role_ids(&state, &room_id, &user_id).await;
                if !ch.write_roles.iter().any(|r| user_roles.contains(r)) {
                    return Err(error_response(
                        StatusCode::FORBIDDEN,
                        "You do not have permission to send messages in this channel",
                    ));
                }
            }
        }
    }

    let event_id = generate_id("$");
    let timestamp = now_millis();

    let mut content = json!({
        "msgtype": req.msgtype.unwrap_or_else(|| "m.text".to_string()),
        "body": req.body
    });

    if req.spoiler == Some(true) {
        content["spoiler"] = json!(true);
    }

    // If replying to a message, look up parent and embed reply metadata
    let mut reply_to_user: Option<String> = None;
    if let Some(ref parent_event_id) = req.in_reply_to {
        content["in_reply_to"] = json!(parent_event_id);

        // Look up parent message from MongoDB
        let msg_coll = state.db.collection::<mongodb::bson::Document>("messages");
        if let Ok(Some(parent)) = msg_coll
            .find_one(doc! { "event_id": parent_event_id, "room_id": &room_id })
            .await
        {
            if let Some(sender) = parent.get_str("sender").ok() {
                content["reply_to_sender"] = json!(sender);
                reply_to_user = Some(sender.to_string());
            }
            if let Some(parent_content) = parent.get_document("content").ok() {
                if let Some(body) = parent_content.get_str("body").ok() {
                    let preview: String = body.chars().take(100).collect();
                    content["reply_to_body"] = json!(preview);
                }
                if parent_content.get_bool("spoiler").unwrap_or(false) {
                    content["reply_to_spoiler"] = json!(true);
                }
            }
        }
    }

    let mut event = json!({
        "type": "m.room.message",
        "room_id": room_id,
        "sender": user_id,
        "content": content,
        "event_id": event_id,
        "origin_server_ts": timestamp
    });
    if !channel_id.is_empty() {
        event["channel_id"] = json!(channel_id);
    }

    // Check if sender is currently in babble mode for this room
    let is_babbled = {
        let babbled = state.babbled_users.read().await;
        babbled
            .get(&room_id)
            .map(|s| s.contains(&user_id))
            .unwrap_or(false)
    };
    if is_babbled {
        event["babble"] = json!(true);
    }

    // Store in MongoDB
    let msg_coll = state.db.collection::<mongodb::bson::Document>("messages");
    if let Ok(doc) = mongodb::bson::to_document(&event) {
        let _ = msg_coll.insert_one(doc).await;
    }

    if is_babbled {
        broadcast_babble_message(&state, &room_id, &event).await;
    } else {
        broadcast_to_room(&state, &room_id, &event).await;
    }

    // Send reply notification
    if let Some(ref replied_user) = reply_to_user {
        if replied_user != &user_id {
            let notification = json!({
                "type": "m.reply_notification",
                "room_id": room_id,
                "sender": user_id,
                "event_id": event_id,
                "reply_to_event_id": req.in_reply_to,
            });
            send_to_user(&state, replied_user, &notification).await;
        }
    }

    Ok(Json(json!({"event_id": event_id})))
}

pub(crate) async fn get_room_messages(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<MessagesQuery>,
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

    let limit = query.limit.unwrap_or(50) as i64;
    let msg_coll = state.db.collection::<mongodb::bson::Document>("messages");

    // Exclude thread messages (those with a thread_id field) from room message feed
    // If channel_id is provided, filter by it; otherwise show messages without channel_id (backward compat)
    let base_filter = if let Some(ref cid) = query.channel_id {
        doc! { "room_id": &room_id, "thread_id": { "$exists": false }, "$or": [
            { "channel_id": cid },
            { "channel_id": { "$exists": false } }
        ] }
    } else {
        doc! { "room_id": &room_id, "thread_id": { "$exists": false } }
    };

    // Get total count for this room (excluding thread messages)
    let total = msg_coll
        .count_documents(base_filter.clone())
        .await
        .unwrap_or(0) as usize;

    let (start, end, has_more) = if let Some(around_ts) = query.around_ts {
        // Count messages with timestamp <= around_ts to find the position
        let around_filter = if let Some(ref cid) = query.channel_id {
            doc! { "room_id": &room_id, "thread_id": { "$exists": false }, "origin_server_ts": { "$lte": around_ts }, "$or": [
                { "channel_id": cid },
                { "channel_id": { "$exists": false } }
            ] }
        } else {
            doc! { "room_id": &room_id, "thread_id": { "$exists": false }, "origin_server_ts": { "$lte": around_ts } }
        };
        let pos = msg_coll
            .count_documents(around_filter)
            .await
            .unwrap_or(0) as usize;
        let half = (limit as usize) / 2;
        let s = pos.saturating_sub(half);
        let e = (s + limit as usize).min(total);
        (s, e, s > 0)
    } else {
        let e = query.before.unwrap_or(total).min(total);
        let s = e.saturating_sub(limit as usize);
        (s, e, s > 0)
    };

    // Query messages sorted by timestamp ascending, skip `start`, limit `end - start`
    let fetch_count = (end - start) as i64;
    let mut cursor = msg_coll
        .find(base_filter)
        .sort(doc! { "origin_server_ts": 1 })
        .skip(start as u64)
        .limit(fetch_count)
        .await
        .map_err(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "DB query failed"))?;

    let mut chunk: Vec<Value> = Vec::new();
    while let Ok(Some(doc)) = cursor.try_next().await {
        // Remove MongoDB _id field
        let mut doc = doc;
        doc.remove("_id");
        if let Ok(val) = serde_json::to_value(&doc) {
            chunk.push(val);
        }
    }

    // Batch-fetch reactions and thread reply counts for all messages in the chunk
    let event_ids: Vec<String> = chunk
        .iter()
        .filter_map(|m| m.get("event_id").and_then(|v| v.as_str()).map(String::from))
        .collect();
    let reactions_map = get_reactions_for_events(&state, &event_ids).await;
    let thread_counts = get_thread_counts_for_events(&state, &event_ids).await;

    // Attach reactions and thread reply counts to each message
    for msg in chunk.iter_mut() {
        let eid = msg.get("event_id").and_then(|v| v.as_str()).map(String::from);
        if let Some(eid) = eid {
            if let Some(reactions) = reactions_map.get(&eid) {
                if !reactions.is_empty() {
                    msg.as_object_mut().unwrap().insert(
                        "reactions".to_string(),
                        serde_json::to_value(reactions).unwrap(),
                    );
                }
            }
            if let Some(&count) = thread_counts.get(&eid) {
                if count > 0 {
                    msg.as_object_mut().unwrap().insert(
                        "thread_reply_count".to_string(),
                        serde_json::to_value(count).unwrap(),
                    );
                }
            }
        }
    }

    // For non-privileged users, replace the body of babbled messages with
    // deterministic CJK gibberish (same seed → same text across page loads).
    let role = get_user_role(&state, &room_id, &user_id).await;
    let is_privileged = role == "owner" || role == "moderator";
    if !is_privileged {
        for msg in chunk.iter_mut() {
            if msg.get("babble").and_then(|v| v.as_bool()).unwrap_or(false) {
                let eid = msg
                    .get("event_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if let Some(body) = msg
                    .get("content")
                    .and_then(|c| c.get("body"))
                    .and_then(|b| b.as_str())
                {
                    let scrambled = babble_text_for_event(body, &eid);
                    if let Some(content) = msg.get_mut("content") {
                        if let Some(obj) = content.as_object_mut() {
                            obj.insert("body".to_string(), json!(scrambled));
                        }
                    }
                }
                // Remove the babble flag so non-privileged clients don't see it
                if let Some(obj) = msg.as_object_mut() {
                    obj.remove("babble");
                }
            }
        }
    }

    Ok(Json(json!({
        "start": start,
        "end": end,
        "has_more": has_more,
        "chunk": chunk
    })))
}

pub(crate) async fn redact_message(
    State(state): State<Arc<AppState>>,
    Path((room_id, event_id, txn_id)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let _ = txn_id;
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

    let msg_coll = state.db.collection::<mongodb::bson::Document>("messages");
    let msg = msg_coll
        .find_one(doc! { "event_id": &event_id, "room_id": &room_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Message not found"))?;

    let msg_sender = msg.get_str("sender").ok().unwrap_or("");
    let is_own = msg_sender == user_id;
    if !is_own {
        let caller_is_mod = is_moderator_or_owner(&state, &room_id, &user_id).await;
        if !caller_is_mod {
            return Err(error_response(
                StatusCode::FORBIDDEN,
                "Can only delete your own messages",
            ));
        }
        // Moderators can't delete owner's messages
        let caller_role = get_user_role(&state, &room_id, &user_id).await;
        if caller_role == "moderator" {
            let sender_role = get_user_role(&state, &room_id, msg_sender).await;
            if sender_role == "owner" {
                return Err(error_response(
                    StatusCode::FORBIDDEN,
                    "Moderators cannot delete the owner's messages",
                ));
            }
        }
    }

    // Update message in MongoDB
    let _ = msg_coll
        .update_one(
            doc! { "event_id": &event_id, "room_id": &room_id },
            doc! {
                "$set": {
                    "content": { "msgtype": "m.text", "body": "[deleted]" },
                    "redacted": true,
                    "redacted_by": &user_id,
                    "redacted_at": now_millis()
                }
            },
        )
        .await;

    let redaction_event_id = generate_id("$");
    let redaction_event = json!({
        "type": "m.room.redaction",
        "room_id": room_id,
        "sender": user_id,
        "redacts": event_id,
        "event_id": redaction_event_id,
        "origin_server_ts": now_millis()
    });

    broadcast_to_room(&state, &room_id, &redaction_event).await;
    Ok(Json(json!({"event_id": redaction_event_id})))
}

pub(crate) async fn edit_message(
    State(state): State<Arc<AppState>>,
    Path((room_id, event_id, txn_id)): Path<(String, String, String)>,
    headers: HeaderMap,
    Json(req): Json<EditMessageRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let _ = txn_id;
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

    let new_body = req.body.trim().to_string();
    if new_body.is_empty() {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "Message body cannot be empty",
        ));
    }

    let msg_coll = state.db.collection::<mongodb::bson::Document>("messages");
    let msg = msg_coll
        .find_one(doc! { "event_id": &event_id, "room_id": &room_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Message not found"))?;

    if msg.get_str("sender").ok() != Some(&user_id) {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "Can only edit your own messages",
        ));
    }

    if msg.get_bool("redacted").unwrap_or(false) {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "Cannot edit a deleted message",
        ));
    }

    let original_body = msg
        .get_document("content")
        .ok()
        .and_then(|c| c.get_str("body").ok())
        .unwrap_or("")
        .to_string();

    // Update in MongoDB
    let _ = msg_coll
        .update_one(
            doc! { "event_id": &event_id, "room_id": &room_id },
            doc! {
                "$set": {
                    "content.body": &new_body,
                    "edited": true,
                    "edited_at": now_millis()
                }
            },
        )
        .await;

    let edit_event_id = generate_id("$");
    let edit_event = json!({
        "type": "m.room.edit",
        "room_id": room_id,
        "sender": user_id,
        "edits": event_id,
        "new_body": new_body,
        "original_body": original_body,
        "event_id": edit_event_id,
        "origin_server_ts": now_millis()
    });

    broadcast_to_room(&state, &room_id, &edit_event).await;
    Ok(Json(json!({"event_id": edit_event_id})))
}

pub(crate) async fn get_thread_messages(
    State(state): State<Arc<AppState>>,
    Path((room_id, thread_event_id)): Path<(String, String)>,
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

    let msg_coll = state.db.collection::<mongodb::bson::Document>("messages");

    // Fetch the root message
    let root_doc = msg_coll
        .find_one(doc! { "event_id": &thread_event_id, "room_id": &room_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Thread root message not found"))?;

    // Check channel-level view permissions on the root message
    if let Some(ch_id) = root_doc.get_str("channel_id").ok().filter(|s| !s.is_empty()) {
        let role = get_user_role(&state, &room_id, &user_id).await;
        if role != "owner" && role != "moderator" {
            let channels_coll = state.db.collection::<ChannelRecord>("channels");
            if let Ok(Some(ch)) = channels_coll.find_one(doc! { "_id": ch_id }).await {
                if !ch.view_roles.is_empty() {
                    let user_roles = get_user_custom_role_ids(&state, &room_id, &user_id).await;
                    if !ch.view_roles.iter().any(|r| user_roles.contains(r)) {
                        return Err(error_response(
                            StatusCode::FORBIDDEN,
                            "You do not have access to this channel",
                        ));
                    }
                }
            }
        }
    }

    let mut root_doc = root_doc;
    root_doc.remove("_id");
    let root_msg = serde_json::to_value(&root_doc).unwrap_or(serde_json::Value::Null);

    // Fetch thread replies
    let mut cursor = msg_coll
        .find(doc! { "room_id": &room_id, "thread_id": &thread_event_id })
        .sort(doc! { "origin_server_ts": 1 })
        .await
        .map_err(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "DB query failed"))?;

    let mut messages: Vec<Value> = Vec::new();
    while let Ok(Some(doc)) = cursor.try_next().await {
        let mut doc = doc;
        doc.remove("_id");
        if let Ok(val) = serde_json::to_value(&doc) {
            messages.push(val);
        }
    }

    // Attach reactions to thread messages
    let event_ids: Vec<String> = messages
        .iter()
        .filter_map(|m| m.get("event_id").and_then(|v| v.as_str()).map(String::from))
        .collect();
    let reactions_map = get_reactions_for_events(&state, &event_ids).await;
    for msg in messages.iter_mut() {
        if let Some(eid) = msg.get("event_id").and_then(|v| v.as_str()) {
            if let Some(reactions) = reactions_map.get(eid) {
                if !reactions.is_empty() {
                    msg.as_object_mut().unwrap().insert(
                        "reactions".to_string(),
                        serde_json::to_value(reactions).unwrap(),
                    );
                }
            }
        }
    }

    Ok(Json(json!({
        "root": root_msg,
        "messages": messages
    })))
}

pub(crate) async fn send_thread_message(
    State(state): State<Arc<AppState>>,
    Path((room_id, thread_event_id, txn_id)): Path<(String, String, String)>,
    headers: HeaderMap,
    Json(req): Json<SendMessageRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let _ = txn_id;
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

    if room.read_only {
        let role = get_user_role(&state, &room_id, &user_id).await;
        if role != "owner" && role != "moderator" {
            return Err(error_response(
                StatusCode::FORBIDDEN,
                "This room is read-only",
            ));
        }
    }

    // Check channel-level view/write permissions on the thread's root message
    let msg_coll = state.db.collection::<mongodb::bson::Document>("messages");
    if let Ok(Some(root_doc)) = msg_coll
        .find_one(doc! { "event_id": &thread_event_id, "room_id": &room_id })
        .await
    {
        if let Ok(ch_id) = root_doc.get_str("channel_id") {
            if !ch_id.is_empty() {
                let channels_coll = state.db.collection::<ChannelRecord>("channels");
                if let Ok(Some(ch)) = channels_coll.find_one(doc! { "_id": ch_id }).await {
                    let role = get_user_role(&state, &room_id, &user_id).await;
                    let is_privileged = role == "owner" || role == "moderator";
                    if !is_privileged {
                        if !ch.view_roles.is_empty() {
                            let user_roles = get_user_custom_role_ids(&state, &room_id, &user_id).await;
                            if !ch.view_roles.iter().any(|r| user_roles.contains(r)) {
                                return Err(error_response(
                                    StatusCode::FORBIDDEN,
                                    "You do not have access to this channel",
                                ));
                            }
                        }
                        if !ch.write_roles.is_empty() {
                            let user_roles = get_user_custom_role_ids(&state, &room_id, &user_id).await;
                            if !ch.write_roles.iter().any(|r| user_roles.contains(r)) {
                                return Err(error_response(
                                    StatusCode::FORBIDDEN,
                                    "You do not have permission to send messages in this channel",
                                ));
                            }
                        }
                    }
                }
            }
        }
    }

    const MAX_MESSAGE_LENGTH: usize = 4000;
    let emoji_marker = regex::Regex::new(r":emoji\{[^}]+\}:").unwrap();
    let display_body = emoji_marker.replace_all(&req.body, "X");
    if display_body.len() > MAX_MESSAGE_LENGTH {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "Message exceeds maximum length of 4000 characters",
        ));
    }

    let event_id = generate_id("$");
    let timestamp = now_millis();

    let content = json!({
        "msgtype": req.msgtype.unwrap_or_else(|| "m.text".to_string()),
        "body": req.body
    });

    let event = json!({
        "type": "m.room.message",
        "room_id": room_id,
        "sender": user_id,
        "content": content,
        "event_id": event_id,
        "thread_id": thread_event_id,
        "origin_server_ts": timestamp
    });

    if let Ok(doc) = mongodb::bson::to_document(&event) {
        let _ = msg_coll.insert_one(doc).await;
    }

    // Count total thread replies for the broadcast
    let reply_count = msg_coll
        .count_documents(doc! { "room_id": &room_id, "thread_id": &thread_event_id })
        .await
        .unwrap_or(0);

    // Extract @mentions from message body and auto-add mentioned users to thread
    let mention_re = Regex::new(r"@(\w+)").unwrap();
    let mentioned_names: Vec<String> = mention_re
        .captures_iter(&req.body)
        .filter_map(|c| c.get(1).map(|m| m.as_str().to_string()))
        .collect();

    let mut added_participants: Vec<String> = Vec::new();
    if !mentioned_names.is_empty() {
        // Look up room members and match by username portion of user_id
        let rm = state.room_members.read().await;
        let room_member_list = rm.get(&room_id).cloned().unwrap_or_default();
        drop(rm);

        let mut new_participant_ids: Vec<String> = Vec::new();
        for name in &mentioned_names {
            let lower = name.to_lowercase();
            for member_id in &room_member_list {
                // user_id format: @username:localhost
                let username = member_id
                    .split(':')
                    .next()
                    .unwrap_or("")
                    .trim_start_matches('@')
                    .to_lowercase();
                if username == lower && member_id != &user_id {
                    new_participant_ids.push(member_id.clone());
                }
            }
        }

        if !new_participant_ids.is_empty() {
            // Add to thread_participants array on the root message (deduplicated)
            // Also ensure the sender is a participant
            let all_to_add: Vec<&str> = new_participant_ids.iter().map(|s| s.as_str()).collect();
            let _ = msg_coll
                .update_one(
                    doc! { "event_id": &thread_event_id, "room_id": &room_id },
                    doc! { "$addToSet": { "thread_participants": { "$each": &all_to_add } } },
                )
                .await;

            added_participants = new_participant_ids;
        }
    }

    // Always ensure the sender is a thread participant
    let _ = msg_coll
        .update_one(
            doc! { "event_id": &thread_event_id, "room_id": &room_id },
            doc! { "$addToSet": { "thread_participants": &user_id } },
        )
        .await;

    // Broadcast to all room members so they can update thread reply counts
    let broadcast_event = json!({
        "type": "m.thread.message",
        "room_id": room_id,
        "sender": user_id,
        "event_id": event_id,
        "thread_id": thread_event_id,
        "content": content,
        "thread_reply_count": reply_count,
        "origin_server_ts": timestamp,
        "added_participants": added_participants
    });

    broadcast_to_room(&state, &room_id, &broadcast_event).await;

    Ok(Json(json!({"event_id": event_id})))
}

pub(crate) async fn set_thread_name(
    State(state): State<Arc<AppState>>,
    Path((room_id, thread_event_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(req): Json<SetThreadNameRequest>,
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

    let msg_coll = state.db.collection::<mongodb::bson::Document>("messages");

    let exists = msg_coll
        .find_one(doc! { "event_id": &thread_event_id, "room_id": &room_id })
        .await
        .ok()
        .flatten()
        .is_some();

    if !exists {
        return Err(error_response(
            StatusCode::NOT_FOUND,
            "Thread root message not found",
        ));
    }

    let name = req.name.trim().to_string();

    msg_coll
        .update_one(
            doc! { "event_id": &thread_event_id, "room_id": &room_id },
            doc! { "$set": { "thread_name": &name } },
        )
        .await
        .map_err(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "DB update failed"))?;

    let broadcast = json!({
        "type": "m.thread.name",
        "room_id": room_id,
        "thread_id": thread_event_id,
        "name": name,
        "sender": user_id,
    });
    broadcast_to_room(&state, &room_id, &broadcast).await;

    Ok(Json(json!({ "ok": true })))
}

pub(crate) async fn get_room_threads(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<ThreadListQuery>,
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

    let msg_coll = state.db.collection::<mongodb::bson::Document>("messages");

    // Collect all distinct thread_ids used in this room
    let raw_ids = msg_coll
        .distinct(
            "thread_id",
            doc! { "room_id": &room_id, "thread_id": { "$exists": true } },
        )
        .await
        .unwrap_or_default();

    let thread_ids: Vec<String> = raw_ids
        .into_iter()
        .filter_map(|v| v.as_str().map(String::from))
        .collect();

    if thread_ids.is_empty() {
        return Ok(Json(json!({ "threads": [] })));
    }

    // Fetch the root messages for those thread ids
    let mut cursor = msg_coll
        .find(doc! { "event_id": { "$in": &thread_ids }, "room_id": &room_id })
        .sort(doc! { "origin_server_ts": -1 })
        .await
        .map_err(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "DB query failed"))?;

    let mut root_msgs: Vec<Value> = Vec::new();
    while let Ok(Some(doc)) = cursor.try_next().await {
        let mut doc = doc;
        doc.remove("_id");
        if let Ok(val) = serde_json::to_value(&doc) {
            root_msgs.push(val);
        }
    }

    // Filter out threads from channels the user cannot view
    let role = get_user_role(&state, &room_id, &user_id).await;
    let is_privileged = role == "owner" || role == "moderator";
    if !is_privileged {
        let channels_coll = state.db.collection::<ChannelRecord>("channels");
        // Collect channel_ids referenced by root messages
        let channel_ids: Vec<String> = root_msgs
            .iter()
            .filter_map(|m| m.get("channel_id").and_then(|v| v.as_str()).map(String::from))
            .collect::<std::collections::HashSet<_>>()
            .into_iter()
            .collect();
        // Fetch channels with view_roles restrictions
        let mut restricted_channels: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
        if !channel_ids.is_empty() {
            let mut ch_cursor = channels_coll
                .find(doc! { "_id": { "$in": &channel_ids }, "view_roles": { "$ne": [] } })
                .await
                .ok();
            if let Some(ref mut cursor) = ch_cursor {
                while let Ok(Some(ch)) = cursor.try_next().await {
                    if !ch.view_roles.is_empty() {
                        restricted_channels.insert(ch.channel_id.clone(), ch.view_roles.clone());
                    }
                }
            }
        }
        if !restricted_channels.is_empty() {
            let user_roles = get_user_custom_role_ids(&state, &room_id, &user_id).await;
            root_msgs.retain(|msg| {
                let ch_id = msg.get("channel_id").and_then(|v| v.as_str()).unwrap_or("");
                if let Some(view_roles) = restricted_channels.get(ch_id) {
                    view_roles.iter().any(|r| user_roles.contains(r))
                } else {
                    true // no restriction or no channel_id
                }
            });
        }
    }

    // Attach reply counts
    let event_ids: Vec<String> = root_msgs
        .iter()
        .filter_map(|m| m.get("event_id").and_then(|v| v.as_str()).map(String::from))
        .collect();
    let counts = get_thread_counts_for_events(&state, &event_ids).await;
    for msg in root_msgs.iter_mut() {
        if let Some(eid) = msg.get("event_id").and_then(|v| v.as_str()) {
            let count = counts.get(eid).copied().unwrap_or(0);
            msg.as_object_mut()
                .unwrap()
                .insert("thread_reply_count".to_string(), json!(count));
        }
    }

    // Optional text filter against thread_name and content.body
    if let Some(q) = query.q.as_deref() {
        let q = q.to_lowercase();
        if !q.is_empty() {
            root_msgs.retain(|msg| {
                let name_match = msg
                    .get("thread_name")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_lowercase().contains(&q))
                    .unwrap_or(false);
                let body_match = msg
                    .get("content")
                    .and_then(|c| c.get("body"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_lowercase().contains(&q))
                    .unwrap_or(false);
                name_match || body_match
            });
        }
    }

    Ok(Json(json!({ "threads": root_msgs })))
}

pub(crate) async fn search_messages(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<SearchQuery>,
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

    let limit = query.limit.unwrap_or(50).min(100);
    let filter = query.filter.as_deref().unwrap_or("all");
    let q = &query.q;

    let mongo_filter = match filter {
        "user" => {
            doc! {
                "room_id": &room_id,
                "sender": { "$regex": q, "$options": "i" }
            }
        }
        "file" => {
            let file_type = query.file_type.as_deref().unwrap_or("all");
            let ext_pattern = match file_type {
                "image" => r"\.(jpg|jpeg|png|gif|webp|bmp|svg)(\?|$|\s)",
                "video" => r"\.(mp4|webm|ogg|mov)(\?|$|\s)",
                "audio" => r"\.(mp3|wav|flac|aac|m4a)(\?|$|\s)",
                "document" => r"\.(pdf|doc|docx|xls|xlsx|txt|zip|tar|gz|rar|7z|csv)(\?|$|\s)",
                _ => r"\.(jpg|jpeg|png|gif|webp|bmp|svg|mp4|webm|ogg|mov|mp3|wav|flac|aac|m4a|pdf|doc|docx|xls|xlsx|txt|zip|tar|gz|rar|7z|csv)(\?|$|\s)",
            };

            let mut conditions = vec![
                doc! { "room_id": &room_id },
                doc! { "content.body": { "$regex": ext_pattern, "$options": "i" } },
            ];

            if !q.is_empty() {
                conditions.push(doc! { "content.body": { "$regex": q, "$options": "i" } });
            }

            doc! { "$and": conditions }
        }
        _ => {
            // "all" — search by message body
            doc! {
                "room_id": &room_id,
                "content.body": { "$regex": q, "$options": "i" }
            }
        }
    };

    let msg_coll = state.db.collection::<mongodb::bson::Document>("messages");
    let mut cursor = msg_coll
        .find(mongo_filter)
        .sort(doc! { "origin_server_ts": -1 })
        .limit(limit)
        .await
        .map_err(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "DB query failed"))?;

    let mut results: Vec<Value> = Vec::new();
    while let Ok(Some(doc)) = cursor.try_next().await {
        let mut doc = doc;
        doc.remove("_id");
        if let Ok(val) = serde_json::to_value(&doc) {
            results.push(val);
        }
    }

    Ok(Json(json!({ "results": results })))
}
