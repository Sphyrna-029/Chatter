use super::super::{
    dto::{EditMessageRequest, MessagesQuery, SearchQuery, SendMessageRequest},
    helpers::{
        broadcast_to_room, error_response, extract_token, generate_id, get_reactions_for_events,
        get_thread_counts_for_events, get_user_from_token, get_user_role, is_moderator_or_owner,
        now_millis, send_to_user,
    },
    state::{AppState, RoomRecord},
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

    let event = json!({
        "type": "m.room.message",
        "room_id": room_id,
        "sender": user_id,
        "content": content,
        "event_id": event_id,
        "origin_server_ts": timestamp
    });

    // Store in MongoDB
    let msg_coll = state.db.collection::<mongodb::bson::Document>("messages");
    if let Ok(doc) = mongodb::bson::to_document(&event) {
        let _ = msg_coll.insert_one(doc).await;
    }

    broadcast_to_room(&state, &room_id, &event).await;

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
    let base_filter = doc! { "room_id": &room_id, "thread_id": { "$exists": false } };

    // Get total count for this room (excluding thread messages)
    let total = msg_coll
        .count_documents(base_filter.clone())
        .await
        .unwrap_or(0) as usize;

    let (start, end, has_more) = if let Some(around_ts) = query.around_ts {
        // Count messages with timestamp <= around_ts to find the position
        let pos = msg_coll
            .count_documents(doc! { "room_id": &room_id, "thread_id": { "$exists": false }, "origin_server_ts": { "$lte": around_ts } })
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

    let msg_coll = state.db.collection::<mongodb::bson::Document>("messages");
    if let Ok(doc) = mongodb::bson::to_document(&event) {
        let _ = msg_coll.insert_one(doc).await;
    }

    // Count total thread replies for the broadcast
    let reply_count = msg_coll
        .count_documents(doc! { "room_id": &room_id, "thread_id": &thread_event_id })
        .await
        .unwrap_or(0);

    // Broadcast to all room members so they can update thread reply counts
    let broadcast_event = json!({
        "type": "m.thread.message",
        "room_id": room_id,
        "sender": user_id,
        "event_id": event_id,
        "thread_id": thread_event_id,
        "content": content,
        "thread_reply_count": reply_count,
        "origin_server_ts": timestamp
    });

    broadcast_to_room(&state, &room_id, &broadcast_event).await;

    Ok(Json(json!({"event_id": event_id})))
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
