use super::{
    constants::{MAX_USERNAME_LENGTH, MIN_USERNAME_LENGTH},
    state::AppState,
};
use axum::{
    extract::ws::Message,
    http::{HeaderMap, StatusCode},
    response::Json,
};
use base64::Engine;
use serde_json::{json, Value};
use std::time::SystemTime;

pub(crate) fn generate_token() -> String {
    use rand::Rng;
    let bytes: [u8; 32] = rand::thread_rng().gen();
    format!(
        "syt_{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
    )
}

pub(crate) fn generate_id(prefix: &str) -> String {
    use rand::Rng;
    let bytes: [u8; 16] = rand::thread_rng().gen();
    format!(
        "{}_{}",
        prefix,
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
    )
}

pub(crate) fn format_user_id(username: &str) -> String {
    format!("@{}:localhost", username)
}

pub(crate) fn validate_username(username: &str) -> Result<(), &'static str> {
    if username.len() < MIN_USERNAME_LENGTH || username.len() > MAX_USERNAME_LENGTH {
        return Err("Username must be 3-42 characters long");
    }

    if !username
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'_')
    {
        return Err("Username may only contain letters, numbers, and underscores");
    }

    Ok(())
}

pub(crate) fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

pub(crate) fn now_secs() -> f64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_secs_f64()
}

pub(crate) fn extract_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|s| s.to_string())
}

pub(crate) async fn get_user_from_token(state: &AppState, token: &str) -> Option<String> {
    state.access_tokens.read().await.get(token).cloned()
}

pub(crate) fn error_response(status: StatusCode, detail: &str) -> (StatusCode, Json<Value>) {
    (
        status,
        Json(json!({"errcode": "M_UNKNOWN", "error": detail})),
    )
}

/// Broadcast a JSON value to all WebSocket-connected members of a room.
/// Caller must NOT hold any locks on active_websockets or room_members.
pub(crate) async fn broadcast_to_room(state: &AppState, room_id: &str, message: &Value) {
    let members = {
        let rm = state.room_members.read().await;
        match rm.get(room_id) {
            Some(m) => m.clone(),
            None => return,
        }
    };
    let text = message.to_string();
    let ws_map = state.active_websockets.read().await;
    for uid in &members {
        if let Some(tx) = ws_map.get(uid) {
            let _ = tx.send(Message::Text(text.clone().into()));
        }
    }
}

/// Join a user to a room, broadcasting member join + system message.
/// Returns true if the user was newly added, false if already a member.
/// Caller must NOT hold any locks.
pub(crate) async fn do_join_room(state: &AppState, room_id: &str, user_id: &str) -> bool {
    let mut rm = state.room_members.write().await;
    let members = rm.entry(room_id.to_string()).or_insert_with(Vec::new);
    let need_broadcast = !members.contains(&user_id.to_string());
    if need_broadcast {
        members.push(user_id.to_string());
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
        broadcast_to_room(state, room_id, &event).await;

        let display = user_id
            .split(':')
            .next()
            .unwrap_or(user_id)
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
            .entry(room_id.to_string())
            .or_insert_with(Vec::new)
            .push(sys_event.clone());
        broadcast_to_room(state, room_id, &sys_event).await;
    }
    need_broadcast
}

/// Send a JSON message to a single WebSocket-connected user.
pub(crate) async fn send_to_user(state: &AppState, user_id: &str, message: &Value) {
    let ws_map = state.active_websockets.read().await;
    if let Some(tx) = ws_map.get(user_id) {
        let _ = tx.send(Message::Text(message.to_string().into()));
    }
}
