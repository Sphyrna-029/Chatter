use super::{
    screen_webrtc::{
        handle_screen_webrtc_publish_candidate, handle_screen_webrtc_publish_offer,
        handle_screen_webrtc_subscribe_candidate, handle_screen_webrtc_subscribe_offer,
        teardown_screen_publisher, teardown_screen_subscriber_pair,
        teardown_screen_subscriptions_for_viewer,
    },
    voice_webrtc::{
        handle_voice_webrtc_publish_candidate, handle_voice_webrtc_publish_offer,
        handle_voice_webrtc_subscribe_candidate, handle_voice_webrtc_subscribe_offer,
        teardown_voice_publisher, teardown_voice_subscriptions_for_listener,
    },
};
use crate::backend::{
    helpers::{broadcast_to_room, get_user_from_token, now_secs, send_to_user},
    state::{AppState, PresenceRecord, VoiceMemberState},
};
use axum::{
    extract::ws::{Message, WebSocket},
    extract::{State, WebSocketUpgrade},
    response::IntoResponse,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};
use tokio::sync::mpsc;

pub(crate) async fn ws_upgrade(
    State(state): State<Arc<AppState>>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_websocket(state, socket))
}

pub(crate) async fn handle_websocket(state: Arc<AppState>, socket: WebSocket) {
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
            custom_status: String::new(),
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
        let custom_status = {
            let up = state.user_presence.read().await;
            up.get(&user_id).map(|p| p.custom_status.clone()).unwrap_or_default()
        };
        let event = json!({
            "type": "presence_update",
            "user_id": user_id,
            "status": "active",
            "custom_status": custom_status
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

pub(crate) async fn handle_ws_text(state: Arc<AppState>, user_id: &str, text: &str) {
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
        "set_custom_status" => {
            let custom_status = msg
                .get("custom_status")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            {
                let mut up = state.user_presence.write().await;
                if let Some(p) = up.get_mut(user_id) {
                    p.custom_status = custom_status.clone();
                }
            }
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
                "status": "active",
                "custom_status": custom_status
            });
            for rid in user_rooms {
                broadcast_to_room(&state, &rid, &event).await;
            }
        }
        _ => {}
    }
}

pub(crate) async fn handle_ws_binary(state: &AppState, user_id: &str, data: &[u8]) {
    if data.len() >= 6 && &data[..6] == b"AUDIO:" {
        // Audio with header
        relay_audio(state, user_id, data).await;
    } else {
        // Legacy audio without header
        relay_audio(state, user_id, data).await;
    }
}
pub(crate) async fn relay_audio(state: &AppState, user_id: &str, data: &[u8]) {
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

pub(crate) async fn cleanup_disconnect(state: &AppState, user_id: &str) {
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
