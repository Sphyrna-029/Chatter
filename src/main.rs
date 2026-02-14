use axum::{
    extract::ws::{Message, WebSocket},
    extract::{DefaultBodyLimit, Multipart, Path, Query, State, WebSocketUpgrade},
    http::{HeaderMap, StatusCode},
    response::{Html, IntoResponse, Json},
    routing::{delete, get, post, put},
    Router,
};
use futures_util::{SinkExt, StreamExt};
use rtcp::{
    packet::Packet as RtcpPacket,
    payload_feedbacks::{
        full_intra_request::{FirEntry, FullIntraRequest},
        picture_loss_indication::PictureLossIndication,
    },
    transport_feedbacks::transport_layer_nack::TransportLayerNack,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::SystemTime,
};
use tokio::{
    sync::{broadcast, mpsc, RwLock},
    task::JoinHandle,
};
use tower_http::services::ServeDir;
use webrtc::{
    api::{
        interceptor_registry::register_default_interceptors, media_engine::MediaEngine, APIBuilder,
        API,
    },
    ice_transport::{ice_candidate::RTCIceCandidateInit, ice_server::RTCIceServer},
    interceptor::registry::Registry,
    peer_connection::{
        configuration::RTCConfiguration, peer_connection_state::RTCPeerConnectionState,
        sdp::session_description::RTCSessionDescription, RTCPeerConnection,
    },
    rtp_transceiver::rtp_codec::RTCRtpCodecCapability,
    track::{
        track_local::{track_local_static_rtp::TrackLocalStaticRTP, TrackLocal, TrackLocalWriter},
        track_remote::TrackRemote,
    },
};

const SCREEN_RTP_BUFFER_SIZE: usize = 2048;
const SCREEN_AUDIO_RTP_BUFFER_SIZE: usize = 512;
const VOICE_RTP_BUFFER_SIZE: usize = 256;
const MIN_USERNAME_LENGTH: usize = 3;
const MAX_USERNAME_LENGTH: usize = 24;

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
    webrtc_api: Arc<API>,
    screen_publishers: RwLock<HashMap<String, ScreenPublisherState>>,
    screen_subscribers: RwLock<HashMap<String, ScreenSubscriberState>>,
    voice_publishers: RwLock<HashMap<String, VoicePublisherState>>,
    voice_subscribers: RwLock<HashMap<String, VoiceSubscriberState>>,
    dm_rooms: RwLock<HashMap<String, String>>, // Maps sorted "user1|user2" to room_id
    link_previews: RwLock<HashMap<String, CachedPreview>>,
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
    is_dm: bool,
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

#[derive(Clone, serde::Serialize)]
struct CachedPreview {
    title: Option<String>,
    description: Option<String>,
    image: Option<String>,
    site_name: Option<String>,
}

#[derive(Clone)]
struct ScreenPublisherState {
    room_id: String,
    peer_connection: Arc<RTCPeerConnection>,
    media_ssrc: Option<u32>,
    video_codec: Option<RTCRtpCodecCapability>,
    rtp_sender: Option<broadcast::Sender<rtp::packet::Packet>>,
    audio_ssrc: Option<u32>,
    audio_codec: Option<RTCRtpCodecCapability>,
    audio_rtp_sender: Option<broadcast::Sender<rtp::packet::Packet>>,
}

struct ScreenSubscriberState {
    viewer_user_id: String,
    sharer_user_id: String,
    peer_connection: Arc<RTCPeerConnection>,
    forward_task: JoinHandle<()>,
    audio_forward_task: Option<JoinHandle<()>>,
}

#[derive(Clone)]
struct VoicePublisherState {
    room_id: String,
    peer_connection: Arc<RTCPeerConnection>,
    audio_codec: Option<RTCRtpCodecCapability>,
    rtp_sender: Option<broadcast::Sender<rtp::packet::Packet>>,
}

struct VoiceSubscriberState {
    listener_user_id: String,
    speaker_user_id: String,
    peer_connection: Arc<RTCPeerConnection>,
    forward_task: JoinHandle<()>,
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
    is_direct: Option<bool>,
}

#[derive(Deserialize)]
struct SendMessageRequest {
    msgtype: Option<String>,
    body: String,
    in_reply_to: Option<String>,
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

#[derive(Deserialize)]
struct UpdateTopicRequest {
    topic: String,
}

#[derive(Deserialize)]
struct LinkPreviewQuery {
    url: String,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn generate_token() -> String {
    use rand::Rng;
    let bytes: [u8; 32] = rand::thread_rng().gen();
    format!(
        "syt_{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
    )
}

fn generate_id(prefix: &str) -> String {
    use rand::Rng;
    let bytes: [u8; 16] = rand::thread_rng().gen();
    format!(
        "{}_{}",
        prefix,
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
    )
}

fn format_user_id(username: &str) -> String {
    format!("@{}:localhost", username)
}

fn validate_username(username: &str) -> Result<(), &'static str> {
    if username.len() < MIN_USERNAME_LENGTH || username.len() > MAX_USERNAME_LENGTH {
        return Err("Username must be 3-24 characters long");
    }

    if !username
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'_')
    {
        return Err("Username may only contain letters, numbers, and underscores");
    }

    Ok(())
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
    (
        status,
        Json(json!({"errcode": "M_UNKNOWN", "error": detail})),
    )
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

/// Send a JSON message to a single WebSocket-connected user.
async fn send_to_user(state: &AppState, user_id: &str, message: &Value) {
    let ws_map = state.active_websockets.read().await;
    if let Some(tx) = ws_map.get(user_id) {
        let _ = tx.send(Message::Text(message.to_string().into()));
    }
}

fn subscriber_key(viewer_user_id: &str, sharer_user_id: &str) -> String {
    format!("{}|{}", viewer_user_id, sharer_user_id)
}

fn parse_ice_candidate(value: &Value) -> Option<RTCIceCandidateInit> {
    let candidate = value.get("candidate")?.as_str()?.to_string();
    let sdp_mid = value
        .get("sdpMid")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let sdp_mline_index = value
        .get("sdpMLineIndex")
        .and_then(|v| v.as_u64())
        .and_then(|n| u16::try_from(n).ok());
    let username_fragment = value
        .get("usernameFragment")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    Some(RTCIceCandidateInit {
        candidate,
        sdp_mid,
        sdp_mline_index,
        username_fragment,
    })
}

fn ice_candidate_to_json(candidate: &RTCIceCandidateInit) -> Value {
    json!({
        "candidate": candidate.candidate,
        "sdpMid": candidate.sdp_mid,
        "sdpMLineIndex": candidate.sdp_mline_index,
        "usernameFragment": candidate.username_fragment
    })
}

fn build_webrtc_api() -> Arc<API> {
    let mut media_engine = MediaEngine::default();
    media_engine
        .register_default_codecs()
        .expect("register_default_codecs failed");

    let mut registry = Registry::new();
    registry = register_default_interceptors(registry, &mut media_engine)
        .expect("register_default_interceptors failed");

    Arc::new(
        APIBuilder::new()
            .with_media_engine(media_engine)
            .with_interceptor_registry(registry)
            .build(),
    )
}

fn default_webrtc_config() -> RTCConfiguration {
    RTCConfiguration {
        ice_servers: vec![RTCIceServer {
            urls: vec!["stun:stun.l.google.com:19302".to_string()],
            ..Default::default()
        }],
        ..Default::default()
    }
}

async fn create_peer_connection(state: &AppState) -> Result<Arc<RTCPeerConnection>, webrtc::Error> {
    state
        .webrtc_api
        .new_peer_connection(default_webrtc_config())
        .await
        .map(Arc::new)
}

fn rewrite_rtcp_feedback_for_publisher(
    packet: &(dyn RtcpPacket + Send + Sync),
    publisher_media_ssrc: u32,
) -> Option<Box<dyn RtcpPacket + Send + Sync>> {
    if packet
        .as_any()
        .downcast_ref::<PictureLossIndication>()
        .is_some()
    {
        return Some(Box::new(PictureLossIndication {
            sender_ssrc: 0,
            media_ssrc: publisher_media_ssrc,
        }));
    }

    if let Some(nack) = packet.as_any().downcast_ref::<TransportLayerNack>() {
        return Some(Box::new(TransportLayerNack {
            sender_ssrc: 0,
            media_ssrc: publisher_media_ssrc,
            nacks: nack.nacks.clone(),
        }));
    }

    if let Some(fir) = packet.as_any().downcast_ref::<FullIntraRequest>() {
        let rewritten_fir = fir
            .fir
            .iter()
            .map(|entry| FirEntry {
                ssrc: publisher_media_ssrc,
                sequence_number: entry.sequence_number,
            })
            .collect::<Vec<_>>();

        return Some(Box::new(FullIntraRequest {
            sender_ssrc: 0,
            media_ssrc: publisher_media_ssrc,
            fir: rewritten_fir,
        }));
    }

    None
}

// ---------------------------------------------------------------------------
// Auth endpoints
// ---------------------------------------------------------------------------

async fn register(
    State(state): State<Arc<AppState>>,
    Json(req): Json<RegisterRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let username = req.username.trim();
    if let Err(detail) = validate_username(username) {
        return Err(error_response(StatusCode::BAD_REQUEST, detail));
    }

    let user_id = format_user_id(username);

    let mut users = state.users.write().await;
    if users.contains_key(&user_id) {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "User already exists",
        ));
    }

    let token = generate_token();
    let device_id = req.device_id.unwrap_or_else(|| generate_id("DEVICE"));

    users.insert(
        user_id.clone(),
        UserRecord {
            password: req.password,
        },
    );
    drop(users);

    state
        .access_tokens
        .write()
        .await
        .insert(token.clone(), user_id.clone());

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
    let username = req.username.trim();
    if let Err(detail) = validate_username(username) {
        return Err(error_response(StatusCode::BAD_REQUEST, detail));
    }

    let user_id = format_user_id(username);

    let users = state.users.read().await;
    match users.get(&user_id) {
        Some(u) if u.password == req.password => {}
        _ => return Err(error_response(StatusCode::FORBIDDEN, "Invalid credentials")),
    }
    drop(users);

    let token = generate_token();
    let device_id = req.device_id.unwrap_or_else(|| generate_id("DEVICE"));

    state
        .access_tokens
        .write()
        .await
        .insert(token.clone(), user_id.clone());

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

async fn join_room(
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

async fn leave_room(
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

async fn joined_rooms(
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

async fn list_all_rooms(State(state): State<Arc<AppState>>) -> Json<Value> {
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
                "screen_share_active": screen_share_active
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

async fn get_room_messages(
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

async fn redact_message(
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

async fn update_room_topic(
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
    let user_id = get_user_from_token(&state, &token)
        .await
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
        let last_msgs: Vec<Value> = room_msgs
            .into_iter()
            .rev()
            .take(10)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();

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

        // For DMs, show the other person's name relative to the viewer
        let display_name = if room_data.is_dm {
            let other = members.iter().find(|m| *m != &user_id);
            if let Some(other_id) = other {
                let other_display = other_id
                    .split(':')
                    .next()
                    .unwrap_or(other_id)
                    .trim_start_matches('@');
                format!("DM with {}", other_display)
            } else {
                room_data.name.clone()
            }
        } else {
            room_data.name.clone()
        };

        let mut state_events = vec![
            json!({
                "type": "m.room.name",
                "state_key": "",
                "content": {"name": display_name},
                "sender": room_data.creator
            }),
            json!({
                "type": "m.room.topic",
                "state_key": "",
                "content": {"topic": room_data.topic},
                "sender": room_data.creator
            }),
            json!({
                "type": "m.room.direct",
                "state_key": "",
                "content": {"is_direct": room_data.is_dm},
                "sender": room_data.creator
            }),
        ];
        if room_data.is_dm {
            state_events.push(json!({
                "type": "m.room.direct",
                "state_key": "",
                "content": {"is_direct": true},
                "sender": room_data.creator
            }));
        }
        state_events.extend(member_events);

        joined_rooms_data.insert(
            room_id.clone(),
            json!({
                "state": {"events": state_events},
                "timeline": {
                    "events": last_msgs,
                    "limited": false,
                    "prev_batch": "t0"
                }
            }),
        );
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

    let emoji = req
        .emoji
        .ok_or_else(|| error_response(StatusCode::BAD_REQUEST, "Emoji required"))?;

    let (action, reactions_snapshot) = {
        let mut reactions = state.message_reactions.write().await;
        let event_reactions = reactions
            .entry(event_id.clone())
            .or_insert_with(HashMap::new);
        let emoji_users = event_reactions
            .entry(emoji.clone())
            .or_insert_with(Vec::new);

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
        let snap: HashMap<String, Vec<String>> =
            reactions.get(&event_id).cloned().unwrap_or_default();
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
    let _user_id = get_user_from_token(&state, &token)
        .await
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
    let _user_id = get_user_from_token(&state, &token)
        .await
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
    let _user_id = get_user_from_token(&state, &token)
        .await
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

                presence_data.insert(
                    member_id.clone(),
                    json!({
                        "status": status,
                        "last_active": presence.last_active,
                        "last_typing": presence.last_typing
                    }),
                );
            } else {
                presence_data.insert(
                    member_id.clone(),
                    json!({
                        "status": "offline",
                        "last_active": 0,
                        "last_typing": 0
                    }),
                );
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

async fn ws_upgrade(State(state): State<Arc<AppState>>, ws: WebSocketUpgrade) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_websocket(state, socket))
}

async fn handle_websocket(state: Arc<AppState>, socket: WebSocket) {
    let (mut ws_sink, mut ws_stream) = socket.split();

    // First message must be auth
    let auth_msg = match ws_stream.next().await {
        Some(Ok(Message::Text(text))) => serde_json::from_str::<Value>(&text).ok(),
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
                .send(Message::Text(
                    json!({"error": "Invalid token"}).to_string().into(),
                ))
                .await;
            let _ = ws_sink.close().await;
            return;
        }
    };

    // Set up mpsc channel for this user
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

    state
        .active_websockets
        .write()
        .await
        .insert(user_id.clone(), tx);

    // Update presence
    state.user_presence.write().await.insert(
        user_id.clone(),
        PresenceRecord {
            last_active: now_secs(),
            last_typing: 0.0,
            connected: true,
        },
    );

    // Broadcast presence to all rooms this user is in
    {
        let rm = state.room_members.read().await;
        let user_rooms: Vec<String> = rm
            .iter()
            .filter(|(_, members)| members.contains(&user_id))
            .map(|(rid, _)| rid.clone())
            .collect();
        drop(rm);
        let event = json!({
            "type": "presence_update",
            "user_id": user_id,
            "status": "active"
        });
        for rid in user_rooms {
            broadcast_to_room(&state, &rid, &event).await;
        }
    }

    // Send connected ack
    let _ = ws_sink
        .send(Message::Text(
            json!({"type": "connected", "user_id": user_id})
                .to_string()
                .into(),
        ))
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
                handle_ws_text(recv_state.clone(), &recv_user_id, &text).await;
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

async fn handle_ws_text(state: Arc<AppState>, user_id: &str, text: &str) {
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
            broadcast_to_room(&state, room_id, &event).await;
        }
        "voice_join" => {
            let voice_members = {
                let mut vc = state.voice_channels.write().await;
                let room_vc = vc.entry(room_id.to_string()).or_insert_with(HashMap::new);
                room_vc.insert(
                    user_id.to_string(),
                    VoiceMemberState {
                        muted: false,
                        screen_sharing: false,
                    },
                );
                room_vc.keys().cloned().collect::<Vec<_>>()
            };
            let event = json!({
                "type": "voice_user_joined",
                "room_id": room_id,
                "user_id": user_id,
                "voice_members": voice_members
            });
            broadcast_to_room(&state, room_id, &event).await;

            // Send list of existing voice publishers to the new joiner
            let existing_publishers: Vec<String> = {
                let publishers = state.voice_publishers.read().await;
                let vc = state.voice_channels.read().await;
                if let Some(room_vc) = vc.get(room_id) {
                    room_vc
                        .keys()
                        .filter(|uid| uid.as_str() != user_id && publishers.contains_key(*uid))
                        .cloned()
                        .collect()
                } else {
                    vec![]
                }
            };
            if !existing_publishers.is_empty() {
                let publishers_msg = json!({
                    "type": "voice_webrtc_publishers_list",
                    "room_id": room_id,
                    "publishers": existing_publishers
                });
                send_to_user(&state, user_id, &publishers_msg).await;
            }
        }
        "voice_leave" => {
            let (voice_members, was_screen_sharing) = {
                let mut vc = state.voice_channels.write().await;
                if let Some(room_vc) = vc.get_mut(room_id) {
                    if let Some(member) = room_vc.remove(user_id) {
                        (
                            room_vc.keys().cloned().collect::<Vec<_>>(),
                            member.screen_sharing,
                        )
                    } else {
                        (room_vc.keys().cloned().collect::<Vec<_>>(), false)
                    }
                } else {
                    (vec![], false)
                }
            };

            // Teardown voice WebRTC
            teardown_voice_subscriptions_for_listener(&state, user_id).await;
            let _ = teardown_voice_publisher(&state, user_id).await;

            teardown_screen_subscriptions_for_viewer(&state, user_id).await;
            let publisher_room = teardown_screen_publisher(&state, user_id).await;

            let event = json!({
                "type": "voice_user_left",
                "room_id": room_id,
                "user_id": user_id,
                "voice_members": voice_members
            });
            broadcast_to_room(&state, room_id, &event).await;

            if was_screen_sharing {
                let event = json!({
                    "type": "screen_share_stopped",
                    "room_id": room_id,
                    "user_id": user_id
                });
                broadcast_to_room(&state, room_id, &event).await;
            } else if let Some(published_room_id) = publisher_room {
                let event = json!({
                    "type": "screen_share_stopped",
                    "room_id": published_room_id,
                    "user_id": user_id
                });
                broadcast_to_room(&state, &published_room_id, &event).await;
            }
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
            broadcast_to_room(&state, room_id, &event).await;
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
            broadcast_to_room(&state, room_id, &event).await;
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
            let _ = teardown_screen_publisher(&state, user_id).await;
            let event = json!({
                "type": "screen_share_stopped",
                "room_id": room_id,
                "user_id": user_id
            });
            broadcast_to_room(&state, room_id, &event).await;
        }
        "screen_webrtc_publish_offer" => {
            let sdp = msg.get("sdp").and_then(|v| v.as_str()).unwrap_or("");
            handle_screen_webrtc_publish_offer(state.clone(), user_id, room_id, sdp).await;
        }
        "screen_webrtc_publish_candidate" => {
            if let Some(candidate_value) = msg.get("candidate") {
                handle_screen_webrtc_publish_candidate(&state, user_id, candidate_value).await;
            }
        }
        "screen_webrtc_subscribe_offer" => {
            let sdp = msg.get("sdp").and_then(|v| v.as_str()).unwrap_or("");
            let sharer_user_id = msg
                .get("sharer_user_id")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            handle_screen_webrtc_subscribe_offer(
                state.clone(),
                user_id,
                room_id,
                sharer_user_id,
                sdp,
            )
            .await;
        }
        "screen_webrtc_subscribe_candidate" => {
            let sharer_user_id = msg
                .get("sharer_user_id")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if let Some(candidate_value) = msg.get("candidate") {
                handle_screen_webrtc_subscribe_candidate(
                    &state,
                    user_id,
                    sharer_user_id,
                    candidate_value,
                )
                .await;
            }
        }
        "screen_webrtc_unsubscribe" => {
            let sharer_user_id = msg
                .get("sharer_user_id")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if !sharer_user_id.is_empty() {
                teardown_screen_subscriber_pair(&state, user_id, sharer_user_id).await;
            }
        }
        "voice_webrtc_publish_offer" => {
            let sdp = msg.get("sdp").and_then(|v| v.as_str()).unwrap_or("");
            handle_voice_webrtc_publish_offer(state.clone(), user_id, room_id, sdp).await;
        }
        "voice_webrtc_publish_candidate" => {
            if let Some(candidate_value) = msg.get("candidate") {
                handle_voice_webrtc_publish_candidate(&state, user_id, candidate_value).await;
            }
        }
        "voice_webrtc_subscribe_offer" => {
            let sdp = msg.get("sdp").and_then(|v| v.as_str()).unwrap_or("");
            let speaker_user_id = msg
                .get("speaker_user_id")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            handle_voice_webrtc_subscribe_offer(
                state.clone(),
                user_id,
                room_id,
                speaker_user_id,
                sdp,
            )
            .await;
        }
        "voice_webrtc_subscribe_candidate" => {
            let speaker_user_id = msg
                .get("speaker_user_id")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if let Some(candidate_value) = msg.get("candidate") {
                handle_voice_webrtc_subscribe_candidate(
                    &state,
                    user_id,
                    speaker_user_id,
                    candidate_value,
                )
                .await;
            }
        }
        _ => {}
    }
}

async fn handle_ws_binary(state: &AppState, user_id: &str, data: &[u8]) {
    if data.len() >= 6 && &data[..6] == b"AUDIO:" {
        // Audio with header
        relay_audio(state, user_id, data).await;
    } else {
        // Legacy audio without header
        relay_audio(state, user_id, data).await;
    }
}

async fn user_in_voice_room(state: &AppState, room_id: &str, user_id: &str) -> bool {
    let vc = state.voice_channels.read().await;
    vc.get(room_id)
        .and_then(|members| members.get(user_id))
        .is_some()
}

async fn user_is_sharing_screen(state: &AppState, room_id: &str, user_id: &str) -> bool {
    let vc = state.voice_channels.read().await;
    vc.get(room_id)
        .and_then(|members| members.get(user_id))
        .map(|member| member.screen_sharing)
        .unwrap_or(false)
}

async fn set_user_screen_sharing(state: &AppState, room_id: &str, user_id: &str, sharing: bool) {
    let mut vc = state.voice_channels.write().await;
    if let Some(room_vc) = vc.get_mut(room_id) {
        if let Some(member) = room_vc.get_mut(user_id) {
            member.screen_sharing = sharing;
        }
    }
}

async fn teardown_screen_subscriber_pair(
    state: &AppState,
    viewer_user_id: &str,
    sharer_user_id: &str,
) {
    let key = subscriber_key(viewer_user_id, sharer_user_id);
    let subscriber = {
        let mut subs = state.screen_subscribers.write().await;
        subs.remove(&key)
    };

    if let Some(subscriber) = subscriber {
        subscriber.forward_task.abort();
        if let Some(audio_task) = subscriber.audio_forward_task {
            audio_task.abort();
        }
        let _ = subscriber.peer_connection.close().await;
    }
}

async fn teardown_screen_subscriptions_for_viewer(state: &AppState, viewer_user_id: &str) {
    let subscribers = {
        let mut subs = state.screen_subscribers.write().await;
        let keys: Vec<String> = subs
            .iter()
            .filter(|(_, entry)| entry.viewer_user_id == viewer_user_id)
            .map(|(key, _)| key.clone())
            .collect();

        let mut removed = Vec::with_capacity(keys.len());
        for key in keys {
            if let Some(entry) = subs.remove(&key) {
                removed.push(entry);
            }
        }
        removed
    };

    for subscriber in subscribers {
        subscriber.forward_task.abort();
        if let Some(audio_task) = subscriber.audio_forward_task {
            audio_task.abort();
        }
        let _ = subscriber.peer_connection.close().await;
    }
}

async fn teardown_screen_subscriptions_for_sharer(state: &AppState, sharer_user_id: &str) {
    let subscribers = {
        let mut subs = state.screen_subscribers.write().await;
        let keys: Vec<String> = subs
            .iter()
            .filter(|(_, entry)| entry.sharer_user_id == sharer_user_id)
            .map(|(key, _)| key.clone())
            .collect();

        let mut removed = Vec::with_capacity(keys.len());
        for key in keys {
            if let Some(entry) = subs.remove(&key) {
                removed.push(entry);
            }
        }
        removed
    };

    for subscriber in subscribers {
        subscriber.forward_task.abort();
        if let Some(audio_task) = subscriber.audio_forward_task {
            audio_task.abort();
        }
        let _ = subscriber.peer_connection.close().await;
    }
}

async fn teardown_screen_publisher(state: &AppState, sharer_user_id: &str) -> Option<String> {
    let publisher = {
        let mut publishers = state.screen_publishers.write().await;
        publishers.remove(sharer_user_id)
    };

    let publisher = match publisher {
        Some(p) => p,
        None => return None,
    };

    teardown_screen_subscriptions_for_sharer(state, sharer_user_id).await;
    let _ = publisher.peer_connection.close().await;
    Some(publisher.room_id)
}

async fn handle_screen_webrtc_publish_offer(
    state: Arc<AppState>,
    user_id: &str,
    room_id: &str,
    sdp: &str,
) {
    if room_id.is_empty() || sdp.is_empty() {
        let error = json!({
            "type": "screen_webrtc_error",
            "scope": "publish",
            "room_id": room_id,
            "detail": "Missing room_id or sdp"
        });
        send_to_user(&state, user_id, &error).await;
        return;
    }

    if !user_in_voice_room(&state, room_id, user_id).await {
        let error = json!({
            "type": "screen_webrtc_error",
            "scope": "publish",
            "room_id": room_id,
            "detail": "You must be in the room voice channel before publishing screen share"
        });
        send_to_user(&state, user_id, &error).await;
        return;
    }

    let _ = teardown_screen_publisher(&state, user_id).await;

    let peer_connection = match create_peer_connection(&state).await {
        Ok(pc) => pc,
        Err(err) => {
            let error = json!({
                "type": "screen_webrtc_error",
                "scope": "publish",
                "room_id": room_id,
                "detail": format!("Failed creating peer connection: {}", err)
            });
            send_to_user(&state, user_id, &error).await;
            return;
        }
    };

    {
        let mut publishers = state.screen_publishers.write().await;
        publishers.insert(
            user_id.to_string(),
            ScreenPublisherState {
                room_id: room_id.to_string(),
                peer_connection: peer_connection.clone(),
                media_ssrc: None,
                video_codec: None,
                rtp_sender: None,
                audio_ssrc: None,
                audio_codec: None,
                audio_rtp_sender: None,
            },
        );
    }

    {
        let state_clone = state.clone();
        let room_id = room_id.to_string();
        let user_id = user_id.to_string();
        peer_connection.on_ice_candidate(Box::new(move |candidate| {
            let state = state_clone.clone();
            let room_id = room_id.clone();
            let user_id = user_id.clone();
            Box::pin(async move {
                let Some(candidate) = candidate else {
                    return;
                };
                let Ok(candidate_init) = candidate.to_json() else {
                    return;
                };
                let response = json!({
                    "type": "screen_webrtc_publish_candidate",
                    "room_id": room_id,
                    "candidate": ice_candidate_to_json(&candidate_init)
                });
                send_to_user(&state, &user_id, &response).await;
            })
        }));
    }

    {
        let state_clone = state.clone();
        let room_id = room_id.to_string();
        let user_id = user_id.to_string();
        peer_connection.on_peer_connection_state_change(Box::new(move |pc_state| {
            let state = state_clone.clone();
            let room_id = room_id.clone();
            let user_id = user_id.clone();
            Box::pin(async move {
                if matches!(
                    pc_state,
                    RTCPeerConnectionState::Failed
                        | RTCPeerConnectionState::Disconnected
                        | RTCPeerConnectionState::Closed
                ) && teardown_screen_publisher(&state, &user_id).await.is_some()
                {
                    set_user_screen_sharing(&state, &room_id, &user_id, false).await;
                    let event = json!({
                        "type": "screen_share_stopped",
                        "room_id": room_id,
                        "user_id": user_id
                    });
                    broadcast_to_room(&state, &room_id, &event).await;
                }
            })
        }));
    }

    {
        let state_clone = state.clone();
        let user_id = user_id.to_string();
        peer_connection.on_track(Box::new(move |track: Arc<TrackRemote>, _, _| {
            let state = state_clone.clone();
            let user_id = user_id.clone();
            Box::pin(async move {
                let codec = track.codec();
                let codec_capability = RTCRtpCodecCapability {
                    mime_type: codec.capability.mime_type.clone(),
                    clock_rate: codec.capability.clock_rate,
                    channels: codec.capability.channels,
                    sdp_fmtp_line: codec.capability.sdp_fmtp_line.clone(),
                    rtcp_feedback: codec.capability.rtcp_feedback.clone(),
                };
                let is_audio = codec.capability.mime_type.starts_with("audio/");

                let buffer_size = if is_audio {
                    SCREEN_AUDIO_RTP_BUFFER_SIZE
                } else {
                    SCREEN_RTP_BUFFER_SIZE
                };
                let (rtp_sender, _) = broadcast::channel::<rtp::packet::Packet>(buffer_size);

                {
                    let mut publishers = state.screen_publishers.write().await;
                    if let Some(publisher) = publishers.get_mut(&user_id) {
                        if is_audio {
                            publisher.audio_ssrc = Some(track.ssrc());
                            publisher.audio_codec = Some(codec_capability);
                            publisher.audio_rtp_sender = Some(rtp_sender.clone());
                        } else {
                            publisher.media_ssrc = Some(track.ssrc());
                            publisher.video_codec = Some(codec_capability);
                            publisher.rtp_sender = Some(rtp_sender.clone());
                        }
                    } else {
                        return;
                    }
                }

                // Only notify for video track — audio availability is checked at subscribe time
                if !is_audio {
                    let room_id = {
                        let publishers = state.screen_publishers.read().await;
                        publishers.get(&user_id).map(|p| p.room_id.clone())
                    };
                    if let Some(room_id) = room_id {
                        let event = json!({
                            "type": "screen_webrtc_publisher_ready",
                            "room_id": room_id,
                            "user_id": user_id
                        });
                        broadcast_to_room(&state, &room_id, &event).await;
                    }
                }

                tokio::spawn(async move {
                    while let Ok((rtp_packet, _)) = track.read_rtp().await {
                        let _ = rtp_sender.send(rtp_packet);
                    }
                });
            })
        }));
    }

    let offer = match RTCSessionDescription::offer(sdp.to_string()) {
        Ok(offer) => offer,
        Err(err) => {
            let _ = teardown_screen_publisher(&state, user_id).await;
            let error = json!({
                "type": "screen_webrtc_error",
                "scope": "publish",
                "room_id": room_id,
                "detail": format!("Invalid offer SDP: {}", err)
            });
            send_to_user(&state, user_id, &error).await;
            return;
        }
    };

    if let Err(err) = peer_connection.set_remote_description(offer).await {
        let _ = teardown_screen_publisher(&state, user_id).await;
        let error = json!({
            "type": "screen_webrtc_error",
            "scope": "publish",
            "room_id": room_id,
            "detail": format!("Failed setting remote description: {}", err)
        });
        send_to_user(&state, user_id, &error).await;
        return;
    }

    let answer = match peer_connection.create_answer(None).await {
        Ok(answer) => answer,
        Err(err) => {
            let _ = teardown_screen_publisher(&state, user_id).await;
            let error = json!({
                "type": "screen_webrtc_error",
                "scope": "publish",
                "room_id": room_id,
                "detail": format!("Failed creating answer: {}", err)
            });
            send_to_user(&state, user_id, &error).await;
            return;
        }
    };

    if let Err(err) = peer_connection.set_local_description(answer).await {
        let _ = teardown_screen_publisher(&state, user_id).await;
        let error = json!({
            "type": "screen_webrtc_error",
            "scope": "publish",
            "room_id": room_id,
            "detail": format!("Failed setting local description: {}", err)
        });
        send_to_user(&state, user_id, &error).await;
        return;
    }

    if let Some(local_desc) = peer_connection.local_description().await {
        let response = json!({
            "type": "screen_webrtc_publish_answer",
            "room_id": room_id,
            "sdp": local_desc.sdp
        });
        send_to_user(&state, user_id, &response).await;
    } else {
        let _ = teardown_screen_publisher(&state, user_id).await;
        let error = json!({
            "type": "screen_webrtc_error",
            "scope": "publish",
            "room_id": room_id,
            "detail": "Missing local description for publisher"
        });
        send_to_user(&state, user_id, &error).await;
    }
}

async fn handle_screen_webrtc_publish_candidate(
    state: &AppState,
    user_id: &str,
    candidate_value: &Value,
) {
    let peer_connection = {
        let publishers = state.screen_publishers.read().await;
        publishers
            .get(user_id)
            .map(|publisher| publisher.peer_connection.clone())
    };

    let Some(peer_connection) = peer_connection else {
        return;
    };

    let Some(candidate) = parse_ice_candidate(candidate_value) else {
        return;
    };

    if let Err(err) = peer_connection.add_ice_candidate(candidate).await {
        let error = json!({
            "type": "screen_webrtc_error",
            "scope": "publish",
            "detail": format!("Failed adding ICE candidate: {}", err)
        });
        send_to_user(state, user_id, &error).await;
    }
}

async fn handle_screen_webrtc_subscribe_offer(
    state: Arc<AppState>,
    viewer_user_id: &str,
    room_id: &str,
    sharer_user_id: &str,
    sdp: &str,
) {
    if room_id.is_empty() || sharer_user_id.is_empty() || sdp.is_empty() {
        let error = json!({
            "type": "screen_webrtc_error",
            "scope": "subscribe",
            "room_id": room_id,
            "sharer_user_id": sharer_user_id,
            "detail": "Missing room_id, sharer_user_id, or sdp"
        });
        send_to_user(&state, viewer_user_id, &error).await;
        return;
    }

    if viewer_user_id == sharer_user_id {
        return;
    }

    if !user_in_voice_room(&state, room_id, viewer_user_id).await {
        let error = json!({
            "type": "screen_webrtc_error",
            "scope": "subscribe",
            "room_id": room_id,
            "sharer_user_id": sharer_user_id,
            "detail": "You must be in the room voice channel before subscribing"
        });
        send_to_user(&state, viewer_user_id, &error).await;
        return;
    }

    if !user_is_sharing_screen(&state, room_id, sharer_user_id).await {
        let error = json!({
            "type": "screen_webrtc_error",
            "scope": "subscribe",
            "room_id": room_id,
            "sharer_user_id": sharer_user_id,
            "detail": "The requested sharer is not currently screen sharing"
        });
        send_to_user(&state, viewer_user_id, &error).await;
        return;
    }

    let publisher_state = {
        let publishers = state.screen_publishers.read().await;
        publishers.get(sharer_user_id).cloned()
    };

    let Some(publisher_state) = publisher_state else {
        let error = json!({
            "type": "screen_webrtc_error",
            "scope": "subscribe",
            "room_id": room_id,
            "sharer_user_id": sharer_user_id,
            "detail": "Sharer WebRTC publisher is not connected yet"
        });
        send_to_user(&state, viewer_user_id, &error).await;
        return;
    };

    if publisher_state.room_id != room_id {
        let error = json!({
            "type": "screen_webrtc_error",
            "scope": "subscribe",
            "room_id": room_id,
            "sharer_user_id": sharer_user_id,
            "detail": "Sharer is publishing in a different room"
        });
        send_to_user(&state, viewer_user_id, &error).await;
        return;
    }

    let publisher_peer_connection = publisher_state.peer_connection.clone();

    let Some(publisher_media_ssrc) = publisher_state.media_ssrc else {
        let error = json!({
            "type": "screen_webrtc_error",
            "scope": "subscribe",
            "room_id": room_id,
            "sharer_user_id": sharer_user_id,
            "detail": "Sharer media SSRC not ready yet; retry shortly"
        });
        send_to_user(&state, viewer_user_id, &error).await;
        return;
    };

    let Some(codec_capability) = publisher_state.video_codec.clone() else {
        let error = json!({
            "type": "screen_webrtc_error",
            "scope": "subscribe",
            "room_id": room_id,
            "sharer_user_id": sharer_user_id,
            "detail": "Sharer track not ready yet; retry shortly"
        });
        send_to_user(&state, viewer_user_id, &error).await;
        return;
    };

    let Some(publisher_rtp_sender) = publisher_state.rtp_sender.clone() else {
        let error = json!({
            "type": "screen_webrtc_error",
            "scope": "subscribe",
            "room_id": room_id,
            "sharer_user_id": sharer_user_id,
            "detail": "Sharer RTP stream not ready yet; retry shortly"
        });
        send_to_user(&state, viewer_user_id, &error).await;
        return;
    };

    teardown_screen_subscriber_pair(&state, viewer_user_id, sharer_user_id).await;

    let peer_connection = match create_peer_connection(&state).await {
        Ok(pc) => pc,
        Err(err) => {
            let error = json!({
                "type": "screen_webrtc_error",
                "scope": "subscribe",
                "room_id": room_id,
                "sharer_user_id": sharer_user_id,
                "detail": format!("Failed creating peer connection: {}", err)
            });
            send_to_user(&state, viewer_user_id, &error).await;
            return;
        }
    };

    {
        let state_clone = state.clone();
        let room_id = room_id.to_string();
        let viewer_user_id = viewer_user_id.to_string();
        let sharer_user_id = sharer_user_id.to_string();
        peer_connection.on_ice_candidate(Box::new(move |candidate| {
            let state = state_clone.clone();
            let room_id = room_id.clone();
            let viewer_user_id = viewer_user_id.clone();
            let sharer_user_id = sharer_user_id.clone();
            Box::pin(async move {
                let Some(candidate) = candidate else {
                    return;
                };
                let Ok(candidate_init) = candidate.to_json() else {
                    return;
                };
                let response = json!({
                    "type": "screen_webrtc_subscribe_candidate",
                    "room_id": room_id,
                    "sharer_user_id": sharer_user_id,
                    "candidate": ice_candidate_to_json(&candidate_init)
                });
                send_to_user(&state, &viewer_user_id, &response).await;
            })
        }));
    }

    {
        let state_clone = state.clone();
        let viewer_user_id = viewer_user_id.to_string();
        let sharer_user_id = sharer_user_id.to_string();
        peer_connection.on_peer_connection_state_change(Box::new(move |pc_state| {
            let state = state_clone.clone();
            let viewer_user_id = viewer_user_id.clone();
            let sharer_user_id = sharer_user_id.clone();
            Box::pin(async move {
                if matches!(
                    pc_state,
                    RTCPeerConnectionState::Failed
                        | RTCPeerConnectionState::Disconnected
                        | RTCPeerConnectionState::Closed
                ) {
                    teardown_screen_subscriber_pair(&state, &viewer_user_id, &sharer_user_id).await;
                }
            })
        }));
    }

    let local_track = Arc::new(TrackLocalStaticRTP::new(
        codec_capability,
        format!("screen-{}-{}", sharer_user_id, viewer_user_id),
        "chatter-sfu".to_string(),
    ));

    let track_for_sender: Arc<dyn TrackLocal + Send + Sync> = local_track.clone();
    let rtp_sender = match peer_connection.add_track(track_for_sender).await {
        Ok(sender) => sender,
        Err(err) => {
            let error = json!({
                "type": "screen_webrtc_error",
                "scope": "subscribe",
                "room_id": room_id,
                "sharer_user_id": sharer_user_id,
                "detail": format!("Failed adding relay track: {}", err)
            });
            send_to_user(&state, viewer_user_id, &error).await;
            let _ = peer_connection.close().await;
            return;
        }
    };

    let publisher_peer_connection_for_feedback = publisher_peer_connection.clone();
    tokio::spawn(async move {
        while let Ok((rtcp_packets, _)) = rtp_sender.read_rtcp().await {
            let rewritten_packets = rtcp_packets
                .iter()
                .filter_map(|packet| {
                    rewrite_rtcp_feedback_for_publisher(packet.as_ref(), publisher_media_ssrc)
                })
                .collect::<Vec<_>>();

            if rewritten_packets.is_empty() {
                continue;
            }

            let _ = publisher_peer_connection_for_feedback
                .write_rtcp(&rewritten_packets)
                .await;
        }
    });

    // Request an immediate keyframe so the new subscriber doesn't have to wait
    // for the next natural IDR frame (which can be very rare in screen sharing).
    let _ = publisher_peer_connection
        .write_rtcp(&[Box::new(PictureLossIndication {
            sender_ssrc: 0,
            media_ssrc: publisher_media_ssrc,
        }) as Box<dyn RtcpPacket + Send + Sync>])
        .await;

    let publisher_pc_for_pli = publisher_peer_connection.clone();
    let pli_media_ssrc = publisher_media_ssrc;
    let mut rtp_receiver = publisher_rtp_sender.subscribe();
    let forward_task = tokio::spawn(async move {
        loop {
            match rtp_receiver.recv().await {
                Ok(rtp_packet) => {
                    if local_track.write_rtp(&rtp_packet).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    // Packets were dropped — the decoder's reference frames are stale.
                    // Request a fresh keyframe from the publisher so recovery is fast.
                    eprintln!(
                        "screen-fwd: subscriber lagged by {} packets, requesting keyframe",
                        skipped
                    );
                    let _ = publisher_pc_for_pli
                        .write_rtcp(&[Box::new(PictureLossIndication {
                            sender_ssrc: 0,
                            media_ssrc: pli_media_ssrc,
                        })
                            as Box<dyn RtcpPacket + Send + Sync>])
                        .await;
                    continue;
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    // Forward audio track if the publisher has system audio
    let mut audio_forward_task: Option<JoinHandle<()>> = None;
    if let (Some(audio_codec), Some(audio_rtp_sender), Some(audio_ssrc)) = (
        publisher_state.audio_codec.clone(),
        publisher_state.audio_rtp_sender.clone(),
        publisher_state.audio_ssrc,
    ) {
        let audio_local_track = Arc::new(TrackLocalStaticRTP::new(
            audio_codec,
            format!("screen-audio-{}-{}", sharer_user_id, viewer_user_id),
            "chatter-sfu".to_string(),
        ));

        let audio_track_for_sender: Arc<dyn TrackLocal + Send + Sync> = audio_local_track.clone();
        match peer_connection.add_track(audio_track_for_sender).await {
            Ok(audio_rtp_sender_rtcp) => {
                // Forward RTCP feedback for audio back to the publisher
                let pub_pc_for_audio_feedback = publisher_peer_connection.clone();
                tokio::spawn(async move {
                    while let Ok((rtcp_packets, _)) = audio_rtp_sender_rtcp.read_rtcp().await {
                        let rewritten_packets = rtcp_packets
                            .iter()
                            .filter_map(|packet| {
                                rewrite_rtcp_feedback_for_publisher(packet.as_ref(), audio_ssrc)
                            })
                            .collect::<Vec<_>>();
                        if !rewritten_packets.is_empty() {
                            let _ = pub_pc_for_audio_feedback
                                .write_rtcp(&rewritten_packets)
                                .await;
                        }
                    }
                });

                let mut audio_rtp_receiver = audio_rtp_sender.subscribe();
                audio_forward_task = Some(tokio::spawn(async move {
                    loop {
                        match audio_rtp_receiver.recv().await {
                            Ok(rtp_packet) => {
                                if audio_local_track.write_rtp(&rtp_packet).await.is_err() {
                                    break;
                                }
                            }
                            Err(broadcast::error::RecvError::Lagged(_)) => continue,
                            Err(broadcast::error::RecvError::Closed) => break,
                        }
                    }
                }));
            }
            Err(err) => {
                eprintln!(
                    "screen-sub: failed to add audio track for {}: {}",
                    viewer_user_id, err
                );
            }
        }
    }

    {
        let key = subscriber_key(viewer_user_id, sharer_user_id);
        let mut subs = state.screen_subscribers.write().await;
        subs.insert(
            key,
            ScreenSubscriberState {
                viewer_user_id: viewer_user_id.to_string(),
                sharer_user_id: sharer_user_id.to_string(),
                peer_connection: peer_connection.clone(),
                forward_task,
                audio_forward_task,
            },
        );
    }

    let offer = match RTCSessionDescription::offer(sdp.to_string()) {
        Ok(offer) => offer,
        Err(err) => {
            teardown_screen_subscriber_pair(&state, viewer_user_id, sharer_user_id).await;
            let error = json!({
                "type": "screen_webrtc_error",
                "scope": "subscribe",
                "room_id": room_id,
                "sharer_user_id": sharer_user_id,
                "detail": format!("Invalid offer SDP: {}", err)
            });
            send_to_user(&state, viewer_user_id, &error).await;
            return;
        }
    };

    if let Err(err) = peer_connection.set_remote_description(offer).await {
        teardown_screen_subscriber_pair(&state, viewer_user_id, sharer_user_id).await;
        let error = json!({
            "type": "screen_webrtc_error",
            "scope": "subscribe",
            "room_id": room_id,
            "sharer_user_id": sharer_user_id,
            "detail": format!("Failed setting remote description: {}", err)
        });
        send_to_user(&state, viewer_user_id, &error).await;
        return;
    }

    let answer = match peer_connection.create_answer(None).await {
        Ok(answer) => answer,
        Err(err) => {
            teardown_screen_subscriber_pair(&state, viewer_user_id, sharer_user_id).await;
            let error = json!({
                "type": "screen_webrtc_error",
                "scope": "subscribe",
                "room_id": room_id,
                "sharer_user_id": sharer_user_id,
                "detail": format!("Failed creating answer: {}", err)
            });
            send_to_user(&state, viewer_user_id, &error).await;
            return;
        }
    };

    if let Err(err) = peer_connection.set_local_description(answer).await {
        teardown_screen_subscriber_pair(&state, viewer_user_id, sharer_user_id).await;
        let error = json!({
            "type": "screen_webrtc_error",
            "scope": "subscribe",
            "room_id": room_id,
            "sharer_user_id": sharer_user_id,
            "detail": format!("Failed setting local description: {}", err)
        });
        send_to_user(&state, viewer_user_id, &error).await;
        return;
    }

    if let Some(local_desc) = peer_connection.local_description().await {
        let response = json!({
            "type": "screen_webrtc_subscribe_answer",
            "room_id": room_id,
            "sharer_user_id": sharer_user_id,
            "sdp": local_desc.sdp
        });
        send_to_user(&state, viewer_user_id, &response).await;
    } else {
        teardown_screen_subscriber_pair(&state, viewer_user_id, sharer_user_id).await;
        let error = json!({
            "type": "screen_webrtc_error",
            "scope": "subscribe",
            "room_id": room_id,
            "sharer_user_id": sharer_user_id,
            "detail": "Missing local description for subscriber"
        });
        send_to_user(&state, viewer_user_id, &error).await;
    }
}

async fn handle_screen_webrtc_subscribe_candidate(
    state: &AppState,
    viewer_user_id: &str,
    sharer_user_id: &str,
    candidate_value: &Value,
) {
    if sharer_user_id.is_empty() {
        return;
    }

    let key = subscriber_key(viewer_user_id, sharer_user_id);
    let peer_connection = {
        let subs = state.screen_subscribers.read().await;
        subs.get(&key).map(|entry| entry.peer_connection.clone())
    };

    let Some(peer_connection) = peer_connection else {
        return;
    };

    let Some(candidate) = parse_ice_candidate(candidate_value) else {
        return;
    };

    if let Err(err) = peer_connection.add_ice_candidate(candidate).await {
        let error = json!({
            "type": "screen_webrtc_error",
            "scope": "subscribe",
            "sharer_user_id": sharer_user_id,
            "detail": format!("Failed adding ICE candidate: {}", err)
        });
        send_to_user(state, viewer_user_id, &error).await;
    }
}

// ---------------------------------------------------------------------------
// Voice WebRTC teardown helpers
// ---------------------------------------------------------------------------

fn voice_subscriber_key(listener_user_id: &str, speaker_user_id: &str) -> String {
    format!("voice:{}|{}", listener_user_id, speaker_user_id)
}

async fn teardown_voice_subscriber_pair(
    state: &AppState,
    listener_user_id: &str,
    speaker_user_id: &str,
) {
    let key = voice_subscriber_key(listener_user_id, speaker_user_id);
    let subscriber = {
        let mut subs = state.voice_subscribers.write().await;
        subs.remove(&key)
    };

    if let Some(subscriber) = subscriber {
        subscriber.forward_task.abort();
        let _ = subscriber.peer_connection.close().await;
    }
}

async fn teardown_voice_subscriptions_for_listener(state: &AppState, listener_user_id: &str) {
    let subscribers = {
        let mut subs = state.voice_subscribers.write().await;
        let keys: Vec<String> = subs
            .iter()
            .filter(|(_, entry)| entry.listener_user_id == listener_user_id)
            .map(|(key, _)| key.clone())
            .collect();

        let mut removed = Vec::with_capacity(keys.len());
        for key in keys {
            if let Some(entry) = subs.remove(&key) {
                removed.push(entry);
            }
        }
        removed
    };

    for subscriber in subscribers {
        subscriber.forward_task.abort();
        let _ = subscriber.peer_connection.close().await;
    }
}

async fn teardown_voice_subscriptions_for_speaker(state: &AppState, speaker_user_id: &str) {
    let subscribers = {
        let mut subs = state.voice_subscribers.write().await;
        let keys: Vec<String> = subs
            .iter()
            .filter(|(_, entry)| entry.speaker_user_id == speaker_user_id)
            .map(|(key, _)| key.clone())
            .collect();

        let mut removed = Vec::with_capacity(keys.len());
        for key in keys {
            if let Some(entry) = subs.remove(&key) {
                removed.push(entry);
            }
        }
        removed
    };

    for subscriber in subscribers {
        subscriber.forward_task.abort();
        let _ = subscriber.peer_connection.close().await;
    }
}

async fn teardown_voice_publisher(state: &AppState, speaker_user_id: &str) -> Option<String> {
    let publisher = {
        let mut publishers = state.voice_publishers.write().await;
        publishers.remove(speaker_user_id)
    };

    let publisher = match publisher {
        Some(p) => p,
        None => return None,
    };

    teardown_voice_subscriptions_for_speaker(state, speaker_user_id).await;
    let _ = publisher.peer_connection.close().await;
    Some(publisher.room_id)
}

// ---------------------------------------------------------------------------
// Voice WebRTC signaling handlers
// ---------------------------------------------------------------------------

async fn handle_voice_webrtc_publish_offer(
    state: Arc<AppState>,
    user_id: &str,
    room_id: &str,
    sdp: &str,
) {
    if room_id.is_empty() || sdp.is_empty() {
        let error = json!({
            "type": "voice_webrtc_error",
            "scope": "publish",
            "room_id": room_id,
            "detail": "Missing room_id or sdp"
        });
        send_to_user(&state, user_id, &error).await;
        return;
    }

    if !user_in_voice_room(&state, room_id, user_id).await {
        let error = json!({
            "type": "voice_webrtc_error",
            "scope": "publish",
            "room_id": room_id,
            "detail": "You must be in the room voice channel before publishing audio"
        });
        send_to_user(&state, user_id, &error).await;
        return;
    }

    // Teardown any existing publisher for this user
    let _ = teardown_voice_publisher(&state, user_id).await;

    let peer_connection = match create_peer_connection(&state).await {
        Ok(pc) => pc,
        Err(err) => {
            let error = json!({
                "type": "voice_webrtc_error",
                "scope": "publish",
                "room_id": room_id,
                "detail": format!("Failed creating peer connection: {}", err)
            });
            send_to_user(&state, user_id, &error).await;
            return;
        }
    };

    {
        let mut publishers = state.voice_publishers.write().await;
        publishers.insert(
            user_id.to_string(),
            VoicePublisherState {
                room_id: room_id.to_string(),
                peer_connection: peer_connection.clone(),
                audio_codec: None,
                rtp_sender: None,
            },
        );
    }

    // ICE candidate callback
    {
        let state_clone = state.clone();
        let room_id = room_id.to_string();
        let user_id = user_id.to_string();
        peer_connection.on_ice_candidate(Box::new(move |candidate| {
            let state = state_clone.clone();
            let room_id = room_id.clone();
            let user_id = user_id.clone();
            Box::pin(async move {
                let Some(candidate) = candidate else {
                    return;
                };
                let Ok(candidate_init) = candidate.to_json() else {
                    return;
                };
                let response = json!({
                    "type": "voice_webrtc_publish_candidate",
                    "room_id": room_id,
                    "candidate": ice_candidate_to_json(&candidate_init)
                });
                send_to_user(&state, &user_id, &response).await;
            })
        }));
    }

    // Connection state callback
    {
        let state_clone = state.clone();
        let user_id = user_id.to_string();
        peer_connection.on_peer_connection_state_change(Box::new(move |pc_state| {
            let state = state_clone.clone();
            let user_id = user_id.clone();
            Box::pin(async move {
                if matches!(
                    pc_state,
                    RTCPeerConnectionState::Failed
                        | RTCPeerConnectionState::Disconnected
                        | RTCPeerConnectionState::Closed
                ) {
                    let _ = teardown_voice_publisher(&state, &user_id).await;
                }
            })
        }));
    }

    // on_track: receive audio from publisher, fan out via broadcast channel
    {
        let state_clone = state.clone();
        let user_id = user_id.to_string();
        peer_connection.on_track(Box::new(move |track: Arc<TrackRemote>, _, _| {
            let state = state_clone.clone();
            let user_id = user_id.clone();
            Box::pin(async move {
                let codec = track.codec();
                let codec_capability = RTCRtpCodecCapability {
                    mime_type: codec.capability.mime_type.clone(),
                    clock_rate: codec.capability.clock_rate,
                    channels: codec.capability.channels,
                    sdp_fmtp_line: codec.capability.sdp_fmtp_line.clone(),
                    rtcp_feedback: codec.capability.rtcp_feedback.clone(),
                };
                let (rtp_sender, _) =
                    broadcast::channel::<rtp::packet::Packet>(VOICE_RTP_BUFFER_SIZE);

                {
                    let mut publishers = state.voice_publishers.write().await;
                    if let Some(publisher) = publishers.get_mut(&user_id) {
                        publisher.audio_codec = Some(codec_capability);
                        publisher.rtp_sender = Some(rtp_sender.clone());
                    } else {
                        return;
                    }
                }

                // Notify all voice members that this publisher's track is now ready
                let room_id = {
                    let publishers = state.voice_publishers.read().await;
                    publishers.get(&user_id).map(|p| p.room_id.clone())
                };
                if let Some(room_id) = room_id {
                    let event = json!({
                        "type": "voice_webrtc_publisher_ready",
                        "room_id": room_id,
                        "user_id": user_id
                    });
                    broadcast_to_room(&state, &room_id, &event).await;
                }

                // Read RTP from publisher and broadcast
                tokio::spawn(async move {
                    while let Ok((rtp_packet, _)) = track.read_rtp().await {
                        let _ = rtp_sender.send(rtp_packet);
                    }
                });
            })
        }));
    }

    let offer = match RTCSessionDescription::offer(sdp.to_string()) {
        Ok(offer) => offer,
        Err(err) => {
            let _ = teardown_voice_publisher(&state, user_id).await;
            let error = json!({
                "type": "voice_webrtc_error",
                "scope": "publish",
                "room_id": room_id,
                "detail": format!("Invalid offer SDP: {}", err)
            });
            send_to_user(&state, user_id, &error).await;
            return;
        }
    };

    if let Err(err) = peer_connection.set_remote_description(offer).await {
        let _ = teardown_voice_publisher(&state, user_id).await;
        let error = json!({
            "type": "voice_webrtc_error",
            "scope": "publish",
            "room_id": room_id,
            "detail": format!("Failed setting remote description: {}", err)
        });
        send_to_user(&state, user_id, &error).await;
        return;
    }

    let answer = match peer_connection.create_answer(None).await {
        Ok(answer) => answer,
        Err(err) => {
            let _ = teardown_voice_publisher(&state, user_id).await;
            let error = json!({
                "type": "voice_webrtc_error",
                "scope": "publish",
                "room_id": room_id,
                "detail": format!("Failed creating answer: {}", err)
            });
            send_to_user(&state, user_id, &error).await;
            return;
        }
    };

    if let Err(err) = peer_connection.set_local_description(answer).await {
        let _ = teardown_voice_publisher(&state, user_id).await;
        let error = json!({
            "type": "voice_webrtc_error",
            "scope": "publish",
            "room_id": room_id,
            "detail": format!("Failed setting local description: {}", err)
        });
        send_to_user(&state, user_id, &error).await;
        return;
    }

    if let Some(local_desc) = peer_connection.local_description().await {
        let response = json!({
            "type": "voice_webrtc_publish_answer",
            "room_id": room_id,
            "sdp": local_desc.sdp
        });
        send_to_user(&state, user_id, &response).await;
    } else {
        let _ = teardown_voice_publisher(&state, user_id).await;
        let error = json!({
            "type": "voice_webrtc_error",
            "scope": "publish",
            "room_id": room_id,
            "detail": "Missing local description for voice publisher"
        });
        send_to_user(&state, user_id, &error).await;
    }
}

async fn handle_voice_webrtc_publish_candidate(
    state: &AppState,
    user_id: &str,
    candidate_value: &Value,
) {
    let peer_connection = {
        let publishers = state.voice_publishers.read().await;
        publishers
            .get(user_id)
            .map(|publisher| publisher.peer_connection.clone())
    };

    let Some(peer_connection) = peer_connection else {
        return;
    };

    let Some(candidate) = parse_ice_candidate(candidate_value) else {
        return;
    };

    if let Err(err) = peer_connection.add_ice_candidate(candidate).await {
        let error = json!({
            "type": "voice_webrtc_error",
            "scope": "publish",
            "detail": format!("Failed adding ICE candidate: {}", err)
        });
        send_to_user(state, user_id, &error).await;
    }
}

async fn handle_voice_webrtc_subscribe_offer(
    state: Arc<AppState>,
    listener_user_id: &str,
    room_id: &str,
    speaker_user_id: &str,
    sdp: &str,
) {
    if room_id.is_empty() || speaker_user_id.is_empty() || sdp.is_empty() {
        let error = json!({
            "type": "voice_webrtc_error",
            "scope": "subscribe",
            "room_id": room_id,
            "speaker_user_id": speaker_user_id,
            "detail": "Missing room_id, speaker_user_id, or sdp"
        });
        send_to_user(&state, listener_user_id, &error).await;
        return;
    }

    if listener_user_id == speaker_user_id {
        return;
    }

    if !user_in_voice_room(&state, room_id, listener_user_id).await {
        let error = json!({
            "type": "voice_webrtc_error",
            "scope": "subscribe",
            "room_id": room_id,
            "speaker_user_id": speaker_user_id,
            "detail": "You must be in the room voice channel before subscribing"
        });
        send_to_user(&state, listener_user_id, &error).await;
        return;
    }

    let publisher_state = {
        let publishers = state.voice_publishers.read().await;
        publishers.get(speaker_user_id).cloned()
    };

    let Some(publisher_state) = publisher_state else {
        let error = json!({
            "type": "voice_webrtc_error",
            "scope": "subscribe",
            "room_id": room_id,
            "speaker_user_id": speaker_user_id,
            "detail": "Speaker WebRTC publisher is not connected yet"
        });
        send_to_user(&state, listener_user_id, &error).await;
        return;
    };

    if publisher_state.room_id != room_id {
        let error = json!({
            "type": "voice_webrtc_error",
            "scope": "subscribe",
            "room_id": room_id,
            "speaker_user_id": speaker_user_id,
            "detail": "Speaker is publishing in a different room"
        });
        send_to_user(&state, listener_user_id, &error).await;
        return;
    }

    let Some(codec_capability) = publisher_state.audio_codec.clone() else {
        let error = json!({
            "type": "voice_webrtc_error",
            "scope": "subscribe",
            "room_id": room_id,
            "speaker_user_id": speaker_user_id,
            "detail": "Speaker audio track not ready yet; retry shortly"
        });
        send_to_user(&state, listener_user_id, &error).await;
        return;
    };

    let Some(publisher_rtp_sender) = publisher_state.rtp_sender.clone() else {
        let error = json!({
            "type": "voice_webrtc_error",
            "scope": "subscribe",
            "room_id": room_id,
            "speaker_user_id": speaker_user_id,
            "detail": "Speaker RTP stream not ready yet; retry shortly"
        });
        send_to_user(&state, listener_user_id, &error).await;
        return;
    };

    teardown_voice_subscriber_pair(&state, listener_user_id, speaker_user_id).await;

    let peer_connection = match create_peer_connection(&state).await {
        Ok(pc) => pc,
        Err(err) => {
            let error = json!({
                "type": "voice_webrtc_error",
                "scope": "subscribe",
                "room_id": room_id,
                "speaker_user_id": speaker_user_id,
                "detail": format!("Failed creating peer connection: {}", err)
            });
            send_to_user(&state, listener_user_id, &error).await;
            return;
        }
    };

    // ICE candidate callback
    {
        let state_clone = state.clone();
        let room_id = room_id.to_string();
        let listener_user_id = listener_user_id.to_string();
        let speaker_user_id = speaker_user_id.to_string();
        peer_connection.on_ice_candidate(Box::new(move |candidate| {
            let state = state_clone.clone();
            let room_id = room_id.clone();
            let listener_user_id = listener_user_id.clone();
            let speaker_user_id = speaker_user_id.clone();
            Box::pin(async move {
                let Some(candidate) = candidate else {
                    return;
                };
                let Ok(candidate_init) = candidate.to_json() else {
                    return;
                };
                let response = json!({
                    "type": "voice_webrtc_subscribe_candidate",
                    "room_id": room_id,
                    "speaker_user_id": speaker_user_id,
                    "candidate": ice_candidate_to_json(&candidate_init)
                });
                send_to_user(&state, &listener_user_id, &response).await;
            })
        }));
    }

    // Connection state callback
    {
        let state_clone = state.clone();
        let listener_user_id = listener_user_id.to_string();
        let speaker_user_id = speaker_user_id.to_string();
        peer_connection.on_peer_connection_state_change(Box::new(move |pc_state| {
            let state = state_clone.clone();
            let listener_user_id = listener_user_id.clone();
            let speaker_user_id = speaker_user_id.clone();
            Box::pin(async move {
                if matches!(
                    pc_state,
                    RTCPeerConnectionState::Failed
                        | RTCPeerConnectionState::Disconnected
                        | RTCPeerConnectionState::Closed
                ) {
                    teardown_voice_subscriber_pair(&state, &listener_user_id, &speaker_user_id)
                        .await;
                }
            })
        }));
    }

    let local_track = Arc::new(TrackLocalStaticRTP::new(
        codec_capability,
        format!("voice-{}-{}", speaker_user_id, listener_user_id),
        "chatter-sfu".to_string(),
    ));

    let track_for_sender: Arc<dyn TrackLocal + Send + Sync> = local_track.clone();
    if let Err(err) = peer_connection.add_track(track_for_sender).await {
        let error = json!({
            "type": "voice_webrtc_error",
            "scope": "subscribe",
            "room_id": room_id,
            "speaker_user_id": speaker_user_id,
            "detail": format!("Failed adding relay track: {}", err)
        });
        send_to_user(&state, listener_user_id, &error).await;
        let _ = peer_connection.close().await;
        return;
    }

    // Forward RTP from publisher broadcast channel to subscriber local track
    let mut rtp_receiver = publisher_rtp_sender.subscribe();
    let forward_task = tokio::spawn(async move {
        loop {
            match rtp_receiver.recv().await {
                Ok(rtp_packet) => {
                    if local_track.write_rtp(&rtp_packet).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    eprintln!(
                        "voice-fwd: subscriber lagged by {} packets, continuing",
                        skipped
                    );
                    continue;
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    {
        let key = voice_subscriber_key(listener_user_id, speaker_user_id);
        let mut subs = state.voice_subscribers.write().await;
        subs.insert(
            key,
            VoiceSubscriberState {
                listener_user_id: listener_user_id.to_string(),
                speaker_user_id: speaker_user_id.to_string(),
                peer_connection: peer_connection.clone(),
                forward_task,
            },
        );
    }

    let offer = match RTCSessionDescription::offer(sdp.to_string()) {
        Ok(offer) => offer,
        Err(err) => {
            teardown_voice_subscriber_pair(&state, listener_user_id, speaker_user_id).await;
            let error = json!({
                "type": "voice_webrtc_error",
                "scope": "subscribe",
                "room_id": room_id,
                "speaker_user_id": speaker_user_id,
                "detail": format!("Invalid offer SDP: {}", err)
            });
            send_to_user(&state, listener_user_id, &error).await;
            return;
        }
    };

    if let Err(err) = peer_connection.set_remote_description(offer).await {
        teardown_voice_subscriber_pair(&state, listener_user_id, speaker_user_id).await;
        let error = json!({
            "type": "voice_webrtc_error",
            "scope": "subscribe",
            "room_id": room_id,
            "speaker_user_id": speaker_user_id,
            "detail": format!("Failed setting remote description: {}", err)
        });
        send_to_user(&state, listener_user_id, &error).await;
        return;
    }

    let answer = match peer_connection.create_answer(None).await {
        Ok(answer) => answer,
        Err(err) => {
            teardown_voice_subscriber_pair(&state, listener_user_id, speaker_user_id).await;
            let error = json!({
                "type": "voice_webrtc_error",
                "scope": "subscribe",
                "room_id": room_id,
                "speaker_user_id": speaker_user_id,
                "detail": format!("Failed creating answer: {}", err)
            });
            send_to_user(&state, listener_user_id, &error).await;
            return;
        }
    };

    if let Err(err) = peer_connection.set_local_description(answer).await {
        teardown_voice_subscriber_pair(&state, listener_user_id, speaker_user_id).await;
        let error = json!({
            "type": "voice_webrtc_error",
            "scope": "subscribe",
            "room_id": room_id,
            "speaker_user_id": speaker_user_id,
            "detail": format!("Failed setting local description: {}", err)
        });
        send_to_user(&state, listener_user_id, &error).await;
        return;
    }

    if let Some(local_desc) = peer_connection.local_description().await {
        let response = json!({
            "type": "voice_webrtc_subscribe_answer",
            "room_id": room_id,
            "speaker_user_id": speaker_user_id,
            "sdp": local_desc.sdp
        });
        send_to_user(&state, listener_user_id, &response).await;
    } else {
        teardown_voice_subscriber_pair(&state, listener_user_id, speaker_user_id).await;
        let error = json!({
            "type": "voice_webrtc_error",
            "scope": "subscribe",
            "room_id": room_id,
            "speaker_user_id": speaker_user_id,
            "detail": "Missing local description for voice subscriber"
        });
        send_to_user(&state, listener_user_id, &error).await;
    }
}

async fn handle_voice_webrtc_subscribe_candidate(
    state: &AppState,
    listener_user_id: &str,
    speaker_user_id: &str,
    candidate_value: &Value,
) {
    if speaker_user_id.is_empty() {
        return;
    }

    let key = voice_subscriber_key(listener_user_id, speaker_user_id);
    let peer_connection = {
        let subs = state.voice_subscribers.read().await;
        subs.get(&key).map(|entry| entry.peer_connection.clone())
    };

    let Some(peer_connection) = peer_connection else {
        return;
    };

    let Some(candidate) = parse_ice_candidate(candidate_value) else {
        return;
    };

    if let Err(err) = peer_connection.add_ice_candidate(candidate).await {
        let error = json!({
            "type": "voice_webrtc_error",
            "scope": "subscribe",
            "speaker_user_id": speaker_user_id,
            "detail": format!("Failed adding ICE candidate: {}", err)
        });
        send_to_user(state, listener_user_id, &error).await;
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
    // Teardown voice WebRTC
    teardown_voice_subscriptions_for_listener(state, user_id).await;
    let _ = teardown_voice_publisher(state, user_id).await;

    teardown_screen_subscriptions_for_viewer(state, user_id).await;
    let publisher_room = teardown_screen_publisher(state, user_id).await;

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

    let mut stopped_screen_rooms = HashSet::new();

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
            stopped_screen_rooms.insert(room_id);
        }
    }

    if let Some(room_id) = publisher_room {
        if !stopped_screen_rooms.contains(&room_id) {
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

    // Broadcast offline presence to all rooms this user is in
    {
        let rm = state.room_members.read().await;
        let user_rooms: Vec<String> = rm
            .iter()
            .filter(|(_, members)| members.contains(&user_id.to_string()))
            .map(|(rid, _)| rid.clone())
            .collect();
        drop(rm);
        let event = json!({
            "type": "presence_update",
            "user_id": user_id,
            "status": "offline"
        });
        for rid in user_rooms {
            broadcast_to_room(state, &rid, &event).await;
        }
    }
}

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------

async fn serve_client() -> Html<String> {
    let html = std::fs::read_to_string("client/dist/index.html")
        .unwrap_or_else(|_| "<h1>No client found.</h1>".to_string());
    Html(html)
}

async fn versions() -> Json<Value> {
    Json(json!({
        "versions": ["r0.5.0", "r0.6.0", "r0.6.1"]
    }))
}

// ---------------------------------------------------------------------------
// File upload
// ---------------------------------------------------------------------------

const MAX_UPLOAD_SIZE: usize = 10 * 1024 * 1024; // 10MB

async fn upload_file(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> impl IntoResponse {
    let token = match extract_token(&headers) {
        Some(t) => t,
        None => return error_response(StatusCode::UNAUTHORIZED, "Missing token"),
    };
    if get_user_from_token(&state, &token).await.is_none() {
        return error_response(StatusCode::UNAUTHORIZED, "Invalid token");
    }

    let mut filename = String::new();
    let mut data = None;

    while let Ok(Some(field)) = multipart.next_field().await {
        let name = field.name().unwrap_or("").to_string();
        if name == "filename" {
            if let Ok(text) = field.text().await {
                filename = text;
            }
        } else if name == "file" {
            if filename.is_empty() {
                filename = field.file_name().unwrap_or("upload").to_string();
            }
            match field.bytes().await {
                Ok(b) => data = Some(b),
                Err(_) => return error_response(StatusCode::BAD_REQUEST, "Failed to read file"),
            }
        }
    }

    let data = match data {
        Some(d) => d,
        None => return error_response(StatusCode::BAD_REQUEST, "No file field"),
    };

    let filename = filename.replace(['/', '\\', '\0'], "_");
    if filename.is_empty() {
        return error_response(StatusCode::BAD_REQUEST, "No filename provided");
    }

    if data.len() > MAX_UPLOAD_SIZE {
        return error_response(StatusCode::BAD_REQUEST, "File too large (max 10MB)");
    }

    // Generate random folder name
    use rand::Rng;
    let bytes: [u8; 16] = rand::thread_rng().gen();
    let folder: String = bytes.iter().map(|b| format!("{:02x}", b)).collect();

    let dir = format!("external/{}", folder);
    if tokio::fs::create_dir_all(&dir).await.is_err() {
        return error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to create directory",
        );
    }

    let path = format!("{}/{}", dir, filename);
    if tokio::fs::write(&path, &data).await.is_err() {
        return error_response(StatusCode::INTERNAL_SERVER_ERROR, "Failed to write file");
    }

    let url = format!("https://chatter.zgaf.io/external/{}/{}", folder, filename);
    (StatusCode::OK, Json(json!({ "url": url })))
}

// ---------------------------------------------------------------------------
// Link preview
// ---------------------------------------------------------------------------

fn extract_og_tag(html: &str, property: &str) -> Option<String> {
    // Look for <meta property="og:___" content="...">
    let pattern = format!("property=\"{}\"", property);
    let pos = html.find(&pattern)?;
    let snippet = &html[pos..];
    // Find content attribute
    let content_start = snippet.find("content=\"")? + 9;
    let content_end = snippet[content_start..].find('"')? + content_start;
    let value = snippet[content_start..content_end].to_string();
    if value.is_empty() { return None; }
    Some(value)
}

fn extract_title_tag(html: &str) -> Option<String> {
    let start = html.find("<title")?.checked_add(6)?;
    let rest = &html[start..];
    let after_open = rest.find('>')? + 1;
    let end = rest[after_open..].find("</title>")?;
    let title = rest[after_open..after_open + end].trim().to_string();
    if title.is_empty() { return None; }
    Some(title)
}

async fn link_preview(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<LinkPreviewQuery>,
) -> impl IntoResponse {
    let token = match extract_token(&headers) {
        Some(t) => t,
        None => return error_response(StatusCode::UNAUTHORIZED, "Missing token"),
    };
    if get_user_from_token(&state, &token).await.is_none() {
        return error_response(StatusCode::UNAUTHORIZED, "Invalid token");
    }

    let url = query.url.clone();

    // Check cache
    {
        let cache = state.link_previews.read().await;
        if let Some(cached) = cache.get(&url) {
            return (StatusCode::OK, Json(serde_json::to_value(cached).unwrap()));
        }
    }

    // Fetch the URL
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    let response = match client.get(&url)
        .header("User-Agent", "Chatter/1.0 LinkPreview")
        .send()
        .await
    {
        Ok(r) => r,
        Err(_) => return error_response(StatusCode::BAD_GATEWAY, "Failed to fetch URL"),
    };

    // Limit body to 256KB
    let body = match response.bytes().await {
        Ok(b) if b.len() <= 256 * 1024 => String::from_utf8_lossy(&b).to_string(),
        Ok(b) => String::from_utf8_lossy(&b[..256 * 1024]).to_string(),
        Err(_) => return error_response(StatusCode::BAD_GATEWAY, "Failed to read response"),
    };

    let og_title = extract_og_tag(&body, "og:title");
    let og_description = extract_og_tag(&body, "og:description");
    let og_image = extract_og_tag(&body, "og:image");
    let og_site_name = extract_og_tag(&body, "og:site_name");

    let title = og_title.or_else(|| extract_title_tag(&body));

    let preview = CachedPreview {
        title,
        description: og_description,
        image: og_image,
        site_name: og_site_name,
    };

    // Cache it
    {
        let mut cache = state.link_previews.write().await;
        cache.insert(url, preview.clone());
    }

    (StatusCode::OK, Json(serde_json::to_value(&preview).unwrap()))
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

#[tokio::main]
async fn main() {
    let webrtc_api = build_webrtc_api();

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
        webrtc_api,
        screen_publishers: RwLock::new(HashMap::new()),
        screen_subscribers: RwLock::new(HashMap::new()),
        voice_publishers: RwLock::new(HashMap::new()),
        voice_subscribers: RwLock::new(HashMap::new()),
        dm_rooms: RwLock::new(HashMap::new()),
        link_previews: RwLock::new(HashMap::new()),
    });

    let app = Router::new()
        // Static / client
        .route("/", get(serve_client))
        .nest_service("/assets", ServeDir::new("client/dist/assets"))
        .nest_service("/external", ServeDir::new("external"))
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
        .route(
            "/api/upload",
            post(upload_file).layer(DefaultBodyLimit::max(MAX_UPLOAD_SIZE + 2 * 1024 * 1024)),
        )
        // Messages
        .route(
            "/_matrix/client/r0/rooms/{room_id}/send/m.room.message/{txn_id}",
            put(send_message),
        )
        .route(
            "/_matrix/client/r0/rooms/{room_id}/messages",
            get(get_room_messages),
        )
        .route(
            "/_matrix/client/r0/rooms/{room_id}/redact/{event_id}/{txn_id}",
            delete(redact_message),
        )
        // Room topic
        .route(
            "/_matrix/client/r0/rooms/{room_id}/state/m.room.topic",
            put(update_room_topic),
        )
        // Sync
        .route("/_matrix/client/r0/sync", get(sync))
        // Reactions
        .route(
            "/_matrix/client/r0/rooms/{room_id}/send/m.reaction/{event_id}",
            put(add_reaction),
        )
        .route(
            "/_matrix/client/r0/rooms/{room_id}/event/{event_id}/reactions",
            get(get_reactions),
        )
        // Voice & Presence
        .route("/api/rooms/{room_id}/voice", get(get_voice_channel_status))
        .route("/api/rooms/{room_id}/presence", get(get_room_presence))
        .route("/api/link-preview", get(link_preview))
        // WebSocket
        .route("/ws", get(ws_upgrade))
        .with_state(state);

    println!("Chatter server running on http://0.0.0.0:8000");
    let listener = tokio::net::TcpListener::bind("0.0.0.0:8000").await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
