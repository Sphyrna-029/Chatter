use axum::{
    extract::{Path, Query, State, WebSocketUpgrade},
    extract::ws::{Message, WebSocket},
    http::{HeaderMap, StatusCode},
    response::{Html, IntoResponse, Json},
    routing::{delete, get, post, put},
    Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Arc, time::SystemTime};
use tokio::sync::{mpsc, RwLock};

// ---------------------------------------------------------------------------
// State types
// ---------------------------------------------------------------------------

type WsSender = mpsc::UnboundedSender<Message>;

struct AppState {
    users: RwLock<HashMap<String, UserRecord>>,
    rooms: RwLock<HashMap<String, RoomRecord>>,
    room_members: RwLock<HashMap<String, Vec<String>>>,
    messages: RwLock<HashMap<String, Vec<Value>>>,
    message_reactions: RwLock<HashMap<String, HashMap<String, Vec<String>>>>,
    access_tokens: RwLock<HashMap<String, String>>,
    active_websockets: RwLock<HashMap<String, WsSender>>,
    voice_channels: RwLock<HashMap<String, HashMap<String, VoiceMemberState>>>,
    user_presence: RwLock<HashMap<String, PresenceRecord>>,
    client_html: String,
}

#[derive(Clone)]
struct UserRecord {
    password: String,
}

#[derive(Clone)]
struct RoomRecord {
    name: String,
    topic: String,
    creator: String,
}

#[derive(Clone)]
struct VoiceMemberState {
    muted: bool,
    screen_sharing: bool,
}

#[derive(Clone)]
struct PresenceRecord {
    last_active: f64,
    last_typing: f64,
    connected: bool,
}

// ---------------------------------------------------------------------------
// Request types
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct RegisterRequest {
    username: String,
    password: String,
    device_id: Option<String>,
}

#[derive(Deserialize)]
struct LoginRequest {
    username: String,
    password: String,
    device_id: Option<String>,
}

#[derive(Deserialize)]
struct CreateRoomRequest {
    name: Option<String>,
    topic: Option<String>,
    invite: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct SendMessageRequest {
    msgtype: Option<String>,
    body: String,
}

#[derive(Deserialize)]
struct SyncQuery {
    #[allow(dead_code)]
    timeout: Option<u64>,
}

#[derive(Deserialize)]
struct MessagesQuery {
    limit: Option<usize>,
}

#[derive(Deserialize)]
struct ReactionRequest {
    emoji: Option<String>,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn generate_token() -> String {
    use rand::Rng;
    let bytes: [u8; 32] = rand::thread_rng().gen();
    format!("syt_{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes))
}

fn generate_id(prefix: &str) -> String {
    use rand::Rng;
    let bytes: [u8; 16] = rand::thread_rng().gen();
    format!("{}_{}", prefix, base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes))
}

fn format_user_id(username: &str) -> String {
    format!("@{}:localhost", username)
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

fn now_secs() -> f64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_secs_f64()
}

use base64::Engine;

fn extract_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|s| s.to_string())
}

async fn get_user_from_token(state: &AppState, token: &str) -> Option<String> {
    state.access_tokens.read().await.get(token).cloned()
}

fn error_response(status: StatusCode, detail: &str) -> (StatusCode, Json<Value>) {
    (status, Json(json!({"errcode": "M_UNKNOWN", "error": detail})))
}

/// Broadcast a JSON value to all WebSocket-connected members of a room.
/// Caller must NOT hold any locks on active_websockets or room_members.
async fn broadcast_to_room(state: &AppState, room_id: &str, message: &Value) {
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

// ---------------------------------------------------------------------------
// Auth endpoints
// ---------------------------------------------------------------------------

async fn register(
    State(state): State<Arc<AppState>>,
    Json(req): Json<RegisterRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let user_id = format_user_id(&req.username);

    let mut users = state.users.write().await;
    if users.contains_key(&user_id) {
        return Err(error_response(StatusCode::BAD_REQUEST, "User already exists"));
    }

    let token = generate_token();
    let device_id = req.device_id.unwrap_or_else(|| generate_id("DEVICE"));

    users.insert(user_id.clone(), UserRecord { password: req.password });
    drop(users);

    state.access_tokens.write().await.insert(token.clone(), user_id.clone());

    Ok(Json(json!({
        "user_id": user_id,
        "access_token": token,
        "device_id": device_id
    })))
}

async fn login(
    State(state): State<Arc<AppState>>,
    Json(req): Json<LoginRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let user_id = format_user_id(&req.username);

    let users = state.users.read().await;
    match users.get(&user_id) {
        Some(u) if u.password == req.password => {}
        _ => return Err(error_response(StatusCode::FORBIDDEN, "Invalid credentials")),
    }
    drop(users);

    let token = generate_token();
    let device_id = req.device_id.unwrap_or_else(|| generate_id("DEVICE"));

    state.access_tokens.write().await.insert(token.clone(), user_id.clone());

    Ok(Json(json!({
        "user_id": user_id,
        "access_token": token,
        "device_id": device_id
    })))
}

async fn logout(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;

    let user_id = {
        let tokens = state.access_tokens.read().await;
        tokens.get(&token).cloned()
    };

    if let Some(uid) = &user_id {
        state.active_websockets.write().await.remove(uid);
    }

    state.access_tokens.write().await.remove(&token);

    Ok(Json(json!({})))
}

// ---------------------------------------------------------------------------
// Room endpoints
// ---------------------------------------------------------------------------

async fn create_room(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<CreateRoomRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token).await
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let room_id = generate_id("!");
    let room_count = state.rooms.read().await.len();
    let room_name = req.name.unwrap_or_else(|| format!("Room {}", room_count + 1));

    state.rooms.write().await.insert(room_id.clone(), RoomRecord {
        name: room_name,
        topic: req.topic.unwrap_or_default(),
        creator: user_id.clone(),
    });

    let mut members = vec![user_id.clone()];

    // Add invited users
    if let Some(invite_list) = req.invite {
        let users = state.users.read().await;
        for invited in invite_list {
            if users.contains_key(&invited) && !members.contains(&invited) {
                members.push(invited);
            }
        }
    }

    state.room_members.write().await.insert(room_id.clone(), members);
    state.messages.write().await.insert(room_id.clone(), Vec::new());

    Ok(Json(json!({"room_id": room_id})))
}

async fn join_room(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token).await
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
    }

    Ok(Json(json!({"room_id": room_id})))
}

async fn leave_room(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token).await
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

async fn joined_rooms(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token).await
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let rm = state.room_members.read().await;
    let joined: Vec<String> = rm
        .iter()
        .filter(|(_, members)| members.contains(&user_id))
        .map(|(rid, _)| rid.clone())
        .collect();

    Ok(Json(json!({"joined_rooms": joined})))
}

async fn list_all_rooms(
    State(state): State<Arc<AppState>>,
) -> Json<Value> {
    let rooms = state.rooms.read().await;
    let rm = state.room_members.read().await;

    let room_list: Vec<Value> = rooms
        .iter()
        .map(|(room_id, room)| {
            json!({
                "room_id": room_id,
                "name": room.name,
                "topic": room.topic,
                "member_count": rm.get(room_id).map(|m| m.len()).unwrap_or(0)
            })
        })
        .collect();

    Json(json!({"rooms": room_list}))
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

async fn send_message(
    State(state): State<Arc<AppState>>,
    Path((room_id, txn_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(req): Json<SendMessageRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let _ = txn_id;
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token).await
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    if !state.rooms.read().await.contains_key(&room_id) {
        return Err(error_response(StatusCode::NOT_FOUND, "Room not found"));
    }

    {
        let rm = state.room_members.read().await;
        if !rm.get(&room_id).map(|m| m.contains(&user_id)).unwrap_or(false) {
            return Err(error_response(StatusCode::FORBIDDEN, "Not a member of this room"));
        }
    }

    let event_id = generate_id("$");
    let timestamp = now_millis();

    let event = json!({
        "type": "m.room.message",
        "room_id": room_id,
        "sender": user_id,
        "content": {
            "msgtype": req.msgtype.unwrap_or_else(|| "m.text".to_string()),
            "body": req.body
        },
        "event_id": event_id,
        "origin_server_ts": timestamp
    });

    state.messages.write().await
        .entry(room_id.clone())
        .or_insert_with(Vec::new)
        .push(event.clone());

    broadcast_to_room(&state, &room_id, &event).await;

    Ok(Json(json!({"event_id": event_id})))
}

async fn get_room_messages(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<MessagesQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token).await
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    if !state.rooms.read().await.contains_key(&room_id) {
        return Err(error_response(StatusCode::NOT_FOUND, "Room not found"));
    }

    {
        let rm = state.room_members.read().await;
        if !rm.get(&room_id).map(|m| m.contains(&user_id)).unwrap_or(false) {
            return Err(error_response(StatusCode::FORBIDDEN, "Not a member of this room"));
        }
    }

    let limit = query.limit.unwrap_or(50);
    let msgs = state.messages.read().await;
    let room_msgs = msgs.get(&room_id).cloned().unwrap_or_default();
    let chunk: Vec<Value> = room_msgs.into_iter().rev().take(limit).collect::<Vec<_>>().into_iter().rev().collect();

    Ok(Json(json!({
        "start": "t0",
        "end": "t1",
        "chunk": chunk
    })))
}

async fn redact_message(
    State(state): State<Arc<AppState>>,
    Path((room_id, event_id, txn_id)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let _ = txn_id;
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token).await
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    if !state.rooms.read().await.contains_key(&room_id) {
        return Err(error_response(StatusCode::NOT_FOUND, "Room not found"));
    }

    {
        let rm = state.room_members.read().await;
        if !rm.get(&room_id).map(|m| m.contains(&user_id)).unwrap_or(false) {
            return Err(error_response(StatusCode::FORBIDDEN, "Not a member of this room"));
        }
    }

    let mut msgs = state.messages.write().await;
    if let Some(room_msgs) = msgs.get_mut(&room_id) {
        for msg in room_msgs.iter_mut() {
            if msg.get("event_id").and_then(|v| v.as_str()) == Some(&event_id) {
                if msg.get("sender").and_then(|v| v.as_str()) != Some(&user_id) {
                    return Err(error_response(StatusCode::FORBIDDEN, "Can only delete your own messages"));
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
// Sync
// ---------------------------------------------------------------------------

async fn sync(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(_query): Query<SyncQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token).await
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let rm = state.room_members.read().await;
    let rooms = state.rooms.read().await;
    let msgs = state.messages.read().await;

    let mut joined_rooms_data = serde_json::Map::new();

    for (room_id, members) in rm.iter() {
        if !members.contains(&user_id) {
            continue;
        }

        let room_data = match rooms.get(room_id) {
            Some(r) => r,
            None => continue,
        };

        let room_msgs = msgs.get(room_id).cloned().unwrap_or_default();
        let last_msgs: Vec<Value> = room_msgs.into_iter().rev().take(10).collect::<Vec<_>>().into_iter().rev().collect();

        let member_events: Vec<Value> = members
            .iter()
            .map(|mid| {
                let display = mid.split(':').next().unwrap_or(mid).trim_start_matches('@');
                json!({
                    "type": "m.room.member",
                    "state_key": mid,
                    "content": {
                        "membership": "join",
                        "displayname": display
                    },
                    "sender": mid
                })
            })
            .collect();

        let mut state_events = vec![
            json!({
                "type": "m.room.name",
                "state_key": "",
                "content": {"name": room_data.name},
                "sender": room_data.creator
            }),
            json!({
                "type": "m.room.topic",
                "state_key": "",
                "content": {"topic": room_data.topic},
                "sender": room_data.creator
            }),
        ];
        state_events.extend(member_events);

        joined_rooms_data.insert(room_id.clone(), json!({
            "state": {"events": state_events},
            "timeline": {
                "events": last_msgs,
                "limited": false,
                "prev_batch": "t0"
            }
        }));
    }

    let ts = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_secs();

    Ok(Json(json!({
        "next_batch": format!("s{}", ts),
        "rooms": {
            "join": Value::Object(joined_rooms_data)
        }
    })))
}

// ---------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------

async fn add_reaction(
    State(state): State<Arc<AppState>>,
    Path((room_id, event_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(req): Json<ReactionRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token).await
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    if !state.rooms.read().await.contains_key(&room_id) {
        return Err(error_response(StatusCode::NOT_FOUND, "Room not found"));
    }

    {
        let rm = state.room_members.read().await;
        if !rm.get(&room_id).map(|m| m.contains(&user_id)).unwrap_or(false) {
            return Err(error_response(StatusCode::FORBIDDEN, "Not a member of this room"));
        }
    }

    let emoji = req.emoji
        .ok_or_else(|| error_response(StatusCode::BAD_REQUEST, "Emoji required"))?;

    let (action, reactions_snapshot) = {
        let mut reactions = state.message_reactions.write().await;
        let event_reactions = reactions.entry(event_id.clone()).or_insert_with(HashMap::new);
        let emoji_users = event_reactions.entry(emoji.clone()).or_insert_with(Vec::new);

        let action = if let Some(pos) = emoji_users.iter().position(|u| u == &user_id) {
            emoji_users.remove(pos);
            if emoji_users.is_empty() {
                event_reactions.remove(&emoji);
            }
            "removed"
        } else {
            emoji_users.push(user_id.clone());
            "added"
        };

        // Clone the current reactions for broadcast
        let snap: HashMap<String, Vec<String>> = reactions.get(&event_id).cloned().unwrap_or_default();
        (action.to_string(), snap)
    };

    let reactions_value = serde_json::to_value(&reactions_snapshot).unwrap();

    let broadcast_msg = json!({
        "type": "m.reaction",
        "room_id": room_id,
        "event_id": event_id,
        "emoji": emoji,
        "user_id": user_id,
        "action": action,
        "reactions": reactions_value
    });

    broadcast_to_room(&state, &room_id, &broadcast_msg).await;

    Ok(Json(json!({
        "event_id": generate_id("$"),
        "reactions": reactions_value
    })))
}

async fn get_reactions(
    State(state): State<Arc<AppState>>,
    Path((room_id, event_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let _ = room_id;
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let _user_id = get_user_from_token(&state, &token).await
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let reactions = state.message_reactions.read().await;
    let event_reactions = reactions.get(&event_id).cloned().unwrap_or_default();

    Ok(Json(json!({
        "event_id": event_id,
        "reactions": event_reactions
    })))
}

// ---------------------------------------------------------------------------
// Voice channel status
// ---------------------------------------------------------------------------

async fn get_voice_channel_status(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let _user_id = get_user_from_token(&state, &token).await
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    if !state.rooms.read().await.contains_key(&room_id) {
        return Err(error_response(StatusCode::NOT_FOUND, "Room not found"));
    }

    let vc = state.voice_channels.read().await;
    let voice_members: Vec<Value> = vc
        .get(&room_id)
        .map(|members| {
            members
                .iter()
                .map(|(uid, vs)| {
                    json!({
                        "user_id": uid,
                        "muted": vs.muted,
                        "screen_sharing": vs.screen_sharing
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(Json(json!({
        "room_id": room_id,
        "voice_members": voice_members
    })))
}

// ---------------------------------------------------------------------------
// Presence
// ---------------------------------------------------------------------------

async fn get_room_presence(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let _user_id = get_user_from_token(&state, &token).await
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    if !state.rooms.read().await.contains_key(&room_id) {
        return Err(error_response(StatusCode::NOT_FOUND, "Room not found"));
    }

    let current_time = now_secs();
    let rm = state.room_members.read().await;
    let up = state.user_presence.read().await;

    let mut presence_data = serde_json::Map::new();

    if let Some(members) = rm.get(&room_id) {
        for member_id in members {
            if let Some(presence) = up.get(member_id) {
                let time_since_typing = current_time - presence.last_typing;
                let status = if !presence.connected {
                    "offline"
                } else if time_since_typing < 300.0 {
                    "active"
                } else {
                    "idle"
                };

                presence_data.insert(member_id.clone(), json!({
                    "status": status,
                    "last_active": presence.last_active,
                    "last_typing": presence.last_typing
                }));
            } else {
                presence_data.insert(member_id.clone(), json!({
                    "status": "offline",
                    "last_active": 0,
                    "last_typing": 0
                }));
            }
        }
    }

    Ok(Json(json!({
        "room_id": room_id,
        "presence": Value::Object(presence_data)
    })))
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

async fn ws_upgrade(
    State(state): State<Arc<AppState>>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_websocket(state, socket))
}

async fn handle_websocket(state: Arc<AppState>, socket: WebSocket) {
    let (mut ws_sink, mut ws_stream) = socket.split();

    // First message must be auth
    let auth_msg = match ws_stream.next().await {
        Some(Ok(Message::Text(text))) => {
            serde_json::from_str::<Value>(&text).ok()
        }
        _ => None,
    };

    let token = auth_msg
        .as_ref()
        .and_then(|m| m.get("access_token"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let user_id = match token {
        Some(ref t) => get_user_from_token(&state, t).await,
        None => None,
    };

    let user_id = match user_id {
        Some(uid) => uid,
        None => {
            let _ = ws_sink
                .send(Message::Text(json!({"error": "Invalid token"}).to_string().into()))
                .await;
            let _ = ws_sink.close().await;
            return;
        }
    };

    // Set up mpsc channel for this user
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

    state.active_websockets.write().await.insert(user_id.clone(), tx);

    // Update presence
    state.user_presence.write().await.insert(user_id.clone(), PresenceRecord {
        last_active: now_secs(),
        last_typing: 0.0,
        connected: true,
    });

    // Send connected ack
    let _ = ws_sink
        .send(Message::Text(json!({"type": "connected", "user_id": user_id}).to_string().into()))
        .await;

    // Spawn task to forward from mpsc channel -> ws sink
    let sink_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if ws_sink.send(msg).await.is_err() {
                break;
            }
        }
    });

    // Main receive loop
    let recv_state = state.clone();
    let recv_user_id = user_id.clone();

    while let Some(Ok(msg)) = ws_stream.next().await {
        match msg {
            Message::Text(text) => {
                handle_ws_text(&recv_state, &recv_user_id, &text).await;
            }
            Message::Binary(data) => {
                handle_ws_binary(&recv_state, &recv_user_id, &data).await;
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    // Disconnect cleanup
    cleanup_disconnect(&state, &user_id).await;
    sink_task.abort();
}

async fn handle_ws_text(state: &AppState, user_id: &str, text: &str) {
    let msg: Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return,
    };

    // Update last active
    {
        let mut up = state.user_presence.write().await;
        if let Some(p) = up.get_mut(user_id) {
            p.last_active = now_secs();
        }
    }

    let msg_type = msg.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let room_id = msg.get("room_id").and_then(|v| v.as_str()).unwrap_or("");

    match msg_type {
        "typing" => {
            {
                let mut up = state.user_presence.write().await;
                if let Some(p) = up.get_mut(user_id) {
                    p.last_typing = now_secs();
                }
            }
            let event = json!({
                "type": "user_typing",
                "room_id": room_id,
                "user_id": user_id
            });
            broadcast_to_room(state, room_id, &event).await;
        }
        "voice_join" => {
            let voice_members = {
                let mut vc = state.voice_channels.write().await;
                let room_vc = vc.entry(room_id.to_string()).or_insert_with(HashMap::new);
                room_vc.insert(user_id.to_string(), VoiceMemberState {
                    muted: false,
                    screen_sharing: false,
                });
                room_vc.keys().cloned().collect::<Vec<_>>()
            };
            let event = json!({
                "type": "voice_user_joined",
                "room_id": room_id,
                "user_id": user_id,
                "voice_members": voice_members
            });
            broadcast_to_room(state, room_id, &event).await;
        }
        "voice_leave" => {
            let voice_members = {
                let mut vc = state.voice_channels.write().await;
                if let Some(room_vc) = vc.get_mut(room_id) {
                    room_vc.remove(user_id);
                    room_vc.keys().cloned().collect::<Vec<_>>()
                } else {
                    vec![]
                }
            };
            let event = json!({
                "type": "voice_user_left",
                "room_id": room_id,
                "user_id": user_id,
                "voice_members": voice_members
            });
            broadcast_to_room(state, room_id, &event).await;
        }
        "voice_mute" => {
            let muted = msg.get("muted").and_then(|v| v.as_bool()).unwrap_or(false);
            {
                let mut vc = state.voice_channels.write().await;
                if let Some(room_vc) = vc.get_mut(room_id) {
                    if let Some(member) = room_vc.get_mut(user_id) {
                        member.muted = muted;
                    }
                }
            }
            let event = json!({
                "type": "voice_user_muted",
                "room_id": room_id,
                "user_id": user_id,
                "muted": muted
            });
            broadcast_to_room(state, room_id, &event).await;
        }
        "screen_share_start" => {
            {
                let mut vc = state.voice_channels.write().await;
                if let Some(room_vc) = vc.get_mut(room_id) {
                    if let Some(member) = room_vc.get_mut(user_id) {
                        member.screen_sharing = true;
                    }
                }
            }
            let event = json!({
                "type": "screen_share_started",
                "room_id": room_id,
                "user_id": user_id
            });
            broadcast_to_room(state, room_id, &event).await;
        }
        "screen_share_stop" => {
            {
                let mut vc = state.voice_channels.write().await;
                if let Some(room_vc) = vc.get_mut(room_id) {
                    if let Some(member) = room_vc.get_mut(user_id) {
                        member.screen_sharing = false;
                    }
                }
            }
            let event = json!({
                "type": "screen_share_stopped",
                "room_id": room_id,
                "user_id": user_id
            });
            broadcast_to_room(state, room_id, &event).await;
        }
        _ => {}
    }
}

async fn handle_ws_binary(state: &AppState, user_id: &str, data: &[u8]) {
    if data.len() >= 7 && &data[..7] == b"SCREEN:" {
        // Screen share frame
        let screen_frame = &data[7..];

        // Find which room this user is in and broadcasting screen
        let vc = state.voice_channels.read().await;
        for (_room_id, members) in vc.iter() {
            if let Some(member) = members.get(user_id) {
                if member.screen_sharing {
                    // Tag: SCREEN:<user_id>\n<jpeg_data>
                    let mut tagged = Vec::with_capacity(7 + user_id.len() + 1 + screen_frame.len());
                    tagged.extend_from_slice(b"SCREEN:");
                    tagged.extend_from_slice(user_id.as_bytes());
                    tagged.push(b'\n');
                    tagged.extend_from_slice(screen_frame);

                    let targets: Vec<String> = members
                        .keys()
                        .filter(|mid| mid.as_str() != user_id)
                        .cloned()
                        .collect();
                    drop(vc);

                    let ws_map = state.active_websockets.read().await;
                    for mid in &targets {
                        if let Some(tx) = ws_map.get(mid) {
                            let _ = tx.send(Message::Binary(tagged.clone().into()));
                        }
                    }
                    return;
                }
            }
        }
    } else if data.len() >= 6 && &data[..6] == b"AUDIO:" {
        // Audio with header
        relay_audio(state, user_id, data).await;
    } else {
        // Legacy audio without header
        relay_audio(state, user_id, data).await;
    }
}

async fn relay_audio(state: &AppState, user_id: &str, data: &[u8]) {
    let vc = state.voice_channels.read().await;
    for (_room_id, members) in vc.iter() {
        if let Some(member) = members.get(user_id) {
            if !member.muted {
                let targets: Vec<String> = members
                    .keys()
                    .filter(|mid| mid.as_str() != user_id)
                    .cloned()
                    .collect();
                drop(vc);

                let ws_map = state.active_websockets.read().await;
                for mid in &targets {
                    if let Some(tx) = ws_map.get(mid) {
                        let _ = tx.send(Message::Binary(data.to_vec().into()));
                    }
                }
                return;
            }
        }
    }
}

async fn cleanup_disconnect(state: &AppState, user_id: &str) {
    // Remove from voice channels and broadcast leaves
    let voice_rooms: Vec<(String, bool, Vec<String>)> = {
        let mut vc = state.voice_channels.write().await;
        let mut results = Vec::new();
        for (room_id, members) in vc.iter_mut() {
            if let Some(member) = members.remove(user_id) {
                let remaining: Vec<String> = members.keys().cloned().collect();
                results.push((room_id.clone(), member.screen_sharing, remaining));
            }
        }
        results
    };

    for (room_id, was_screen_sharing, voice_members) in voice_rooms {
        let event = json!({
            "type": "voice_user_left",
            "room_id": room_id,
            "user_id": user_id,
            "voice_members": voice_members
        });
        broadcast_to_room(state, &room_id, &event).await;

        if was_screen_sharing {
            let event = json!({
                "type": "screen_share_stopped",
                "room_id": room_id,
                "user_id": user_id
            });
            broadcast_to_room(state, &room_id, &event).await;
        }
    }

    // Remove websocket
    state.active_websockets.write().await.remove(user_id);

    // Mark offline
    {
        let mut up = state.user_presence.write().await;
        if let Some(p) = up.get_mut(user_id) {
            p.connected = false;
            p.last_active = now_secs();
        }
    }
}

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------

async fn serve_client(State(state): State<Arc<AppState>>) -> Html<String> {
    Html(state.client_html.clone())
}

async fn versions() -> Json<Value> {
    Json(json!({
        "versions": ["r0.5.0", "r0.6.0", "r0.6.1"]
    }))
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

#[tokio::main]
async fn main() {
    // Load client.html at startup
    let client_html = std::fs::read_to_string("client.html")
        .unwrap_or_else(|_| "<h1>client.html not found</h1>".to_string());

    let state = Arc::new(AppState {
        users: RwLock::new(HashMap::new()),
        rooms: RwLock::new(HashMap::new()),
        room_members: RwLock::new(HashMap::new()),
        messages: RwLock::new(HashMap::new()),
        message_reactions: RwLock::new(HashMap::new()),
        access_tokens: RwLock::new(HashMap::new()),
        active_websockets: RwLock::new(HashMap::new()),
        voice_channels: RwLock::new(HashMap::new()),
        user_presence: RwLock::new(HashMap::new()),
        client_html,
    });

    let app = Router::new()
        // Static / client
        .route("/", get(serve_client))
        // Matrix versions
        .route("/_matrix/client/versions", get(versions))
        // Auth
        .route("/_matrix/client/r0/register", post(register))
        .route("/_matrix/client/r0/login", post(login))
        .route("/_matrix/client/r0/logout", post(logout))
        // Rooms
        .route("/_matrix/client/r0/createRoom", post(create_room))
        .route("/_matrix/client/r0/rooms/{room_id}/join", post(join_room))
        .route("/_matrix/client/r0/rooms/{room_id}/leave", post(leave_room))
        .route("/_matrix/client/r0/joined_rooms", get(joined_rooms))
        .route("/api/rooms", get(list_all_rooms))
        // Messages
        .route("/_matrix/client/r0/rooms/{room_id}/send/m.room.message/{txn_id}", put(send_message))
        .route("/_matrix/client/r0/rooms/{room_id}/messages", get(get_room_messages))
        .route("/_matrix/client/r0/rooms/{room_id}/redact/{event_id}/{txn_id}", delete(redact_message))
        // Sync
        .route("/_matrix/client/r0/sync", get(sync))
        // Reactions
        .route("/_matrix/client/r0/rooms/{room_id}/send/m.reaction/{event_id}", put(add_reaction))
        .route("/_matrix/client/r0/rooms/{room_id}/event/{event_id}/reactions", get(get_reactions))
        // Voice & Presence
        .route("/api/rooms/{room_id}/voice", get(get_voice_channel_status))
        .route("/api/rooms/{room_id}/presence", get(get_room_presence))
        // WebSocket
        .route("/ws", get(ws_upgrade))
        .with_state(state);

    println!("Chatter server running on http://0.0.0.0:8000");
    let listener = tokio::net::TcpListener::bind("0.0.0.0:8000").await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
