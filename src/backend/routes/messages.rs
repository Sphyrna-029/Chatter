use super::super::{
    dto::{MessagesQuery, SendMessageRequest},
    helpers::{
        broadcast_to_room, error_response, extract_token, generate_id, get_user_from_token,
        now_millis, send_to_user,
    },
    state::AppState,
};
use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::Json,
};
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
        .await
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    if !state.rooms.read().await.contains_key(&room_id) {
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

    const MAX_MESSAGE_LENGTH: usize = 2000;
    let msgtype = req.msgtype.as_deref().unwrap_or("m.text");
    if msgtype == "m.text" && req.body.len() > MAX_MESSAGE_LENGTH {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "Message exceeds maximum length of 2000 characters",
        ));
    }

    let event_id = generate_id("$");
    let timestamp = now_millis();

    let mut content = json!({
        "msgtype": req.msgtype.unwrap_or_else(|| "m.text".to_string()),
        "body": req.body
    });

    // If replying to a message, look up parent and embed reply metadata
    let mut reply_to_user: Option<String> = None;
    if let Some(ref parent_event_id) = req.in_reply_to {
        content["in_reply_to"] = json!(parent_event_id);

        // Look up parent message to get sender and body preview
        let msgs = state.messages.read().await;
        if let Some(room_msgs) = msgs.get(&room_id) {
            if let Some(parent) = room_msgs
                .iter()
                .find(|m| m.get("event_id").and_then(|v| v.as_str()) == Some(parent_event_id))
            {
                if let Some(sender) = parent.get("sender").and_then(|v| v.as_str()) {
                    content["reply_to_sender"] = json!(sender);
                    reply_to_user = Some(sender.to_string());
                }
                if let Some(body) = parent
                    .get("content")
                    .and_then(|c| c.get("body"))
                    .and_then(|v| v.as_str())
                {
                    // Truncate to 100 chars for preview
                    let preview: String = body.chars().take(100).collect();
                    content["reply_to_body"] = json!(preview);
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

    state
        .messages
        .write()
        .await
        .entry(room_id.clone())
        .or_insert_with(Vec::new)
        .push(event.clone());

    broadcast_to_room(&state, &room_id, &event).await;

    // Send reply notification to the replied-to user (if online, not self-reply)
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
        .await
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    if !state.rooms.read().await.contains_key(&room_id) {
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

    let limit = query.limit.unwrap_or(50);
    let msgs = state.messages.read().await;
    let room_msgs = msgs.get(&room_id).cloned().unwrap_or_default();
    let chunk: Vec<Value> = room_msgs
        .into_iter()
        .rev()
        .take(limit)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();

    Ok(Json(json!({
        "start": "t0",
        "end": "t1",
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
        .await
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    if !state.rooms.read().await.contains_key(&room_id) {
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

    let mut msgs = state.messages.write().await;
    if let Some(room_msgs) = msgs.get_mut(&room_id) {
        for msg in room_msgs.iter_mut() {
            if msg.get("event_id").and_then(|v| v.as_str()) == Some(&event_id) {
                if msg.get("sender").and_then(|v| v.as_str()) != Some(&user_id) {
                    return Err(error_response(
                        StatusCode::FORBIDDEN,
                        "Can only delete your own messages",
                    ));
                }

                msg["content"] = json!({"msgtype": "m.text", "body": "[deleted]"});
                msg["redacted"] = json!(true);
                msg["redacted_by"] = json!(user_id);
                msg["redacted_at"] = json!(now_millis());

                let redaction_event = json!({
                    "type": "m.room.redaction",
                    "room_id": room_id,
                    "sender": user_id,
                    "redacts": event_id,
                    "event_id": generate_id("$"),
                    "origin_server_ts": now_millis()
                });

                let redaction_id = redaction_event["event_id"].as_str().unwrap().to_string();
                drop(msgs);

                broadcast_to_room(&state, &room_id, &redaction_event).await;
                return Ok(Json(json!({"event_id": redaction_id})));
            }
        }
    }

    Err(error_response(StatusCode::NOT_FOUND, "Message not found"))
}

// ---------------------------------------------------------------------------
// Room topic
// ---------------------------------------------------------------------------
