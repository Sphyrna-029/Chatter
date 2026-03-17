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
    helpers::{broadcast_to_room, generate_id, get_user_from_token, is_moderator_or_owner, now_millis, now_secs, send_to_user},
    state::{AppState, PresenceRecord, TankGameRecord, TankPlayer, TugOfWarGame, TugOfWarPlayer, UserRecord, VoiceMemberState, WhiteboardStrokeRecord},
    tankwar_engine,
    tugofwar_engine,
};
use axum::{
    extract::ws::{Message, WebSocket},
    extract::{State, WebSocketUpgrade},
    response::IntoResponse,
};
use futures_util::{SinkExt, StreamExt};
use mongodb::bson::doc;
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

    let is_mobile = auth_msg
        .as_ref()
        .and_then(|m| m.get("is_mobile"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    // JWT decode — no DB call
    let user_id = match token {
        Some(ref t) => get_user_from_token(&state, t),
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

    // Update presence – preserve custom_status and manual_status on reconnect
    // On first connect (no existing PresenceRecord), load persisted values from MongoDB
    {
        let mut up = state.user_presence.write().await;
        if let Some(p) = up.get_mut(&user_id) {
            p.last_active = now_secs();
            p.last_typing = 0.0;
            p.connected = true;
            p.is_mobile = is_mobile;
        } else {
            // Load persisted custom_status and manual_status from user record
            let (saved_custom_status, saved_manual_status) = {
                let users_coll = state.db.collection::<UserRecord>("users");
                match users_coll.find_one(doc! { "_id": &user_id }).await {
                    Ok(Some(u)) => (u.custom_status, u.manual_status),
                    _ => (String::new(), None),
                }
            };
            up.insert(
                user_id.clone(),
                PresenceRecord {
                    last_active: now_secs(),
                    last_typing: 0.0,
                    connected: true,
                    custom_status: saved_custom_status,
                    manual_status: saved_manual_status,
                    is_mobile,
                    steam_game: None,
                    steam_appid: None,
                    game_session_start: None,
                    spotify_track: None,
                    spotify_artist: None,
                    spotify_album_art: None,
                },
            );
        }
    }

    // Broadcast presence to all rooms this user is in
    {
        let rm = state.room_members.read().await;
        let user_rooms: Vec<String> = rm
            .iter()
            .filter(|(_, members)| members.contains(&user_id))
            .map(|(rid, _)| rid.clone())
            .collect();
        drop(rm);
        let (custom_status, presence_is_mobile, steam_game, steam_appid, game_session_start, spotify_track, spotify_artist, spotify_album_art) = {
            let up = state.user_presence.read().await;
            let p = up.get(&user_id);
            (
                p.map(|p| p.custom_status.clone()).unwrap_or_default(),
                p.map(|p| p.is_mobile).unwrap_or(false),
                p.and_then(|p| p.steam_game.clone()),
                p.and_then(|p| p.steam_appid.clone()),
                p.and_then(|p| p.game_session_start),
                p.and_then(|p| p.spotify_track.clone()),
                p.and_then(|p| p.spotify_artist.clone()),
                p.and_then(|p| p.spotify_album_art.clone()),
            )
        };
        // Get avatar/about/banner/display_name from MongoDB
        let (avatar_url, about, banner_url, display_name, name_font_url) = {
            let users_coll = state.db.collection::<UserRecord>("users");
            match users_coll.find_one(doc! { "_id": &user_id }).await {
                Ok(Some(u)) => (u.avatar_url, u.about, u.banner_url, u.display_name, u.name_font_url),
                _ => (String::new(), String::new(), String::new(), String::new(), String::new()),
            }
        };
        let event = json!({
            "type": "presence_update",
            "user_id": user_id,
            "status": "active",
            "custom_status": custom_status,
            "avatar_url": avatar_url,
            "about": about,
            "banner_url": banner_url,
            "display_name": display_name,
            "name_font_url": name_font_url,
            "is_mobile": presence_is_mobile,
            "steam_game": steam_game,
            "steam_appid": steam_appid,
            "game_session_start": game_session_start,
            "spotify_track": spotify_track,
            "spotify_artist": spotify_artist,
            "spotify_album_art": spotify_album_art,
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
            let channel_id = msg.get("channel_id").and_then(|v| v.as_str()).unwrap_or("");
            let mut event = json!({
                "type": "user_typing",
                "room_id": room_id,
                "user_id": user_id
            });
            if !channel_id.is_empty() {
                event["channel_id"] = json!(channel_id);
            }
            broadcast_to_room(&state, room_id, &event).await;
        }
        "voice_join" => {
            let channel_id = msg.get("channel_id").and_then(|v| v.as_str()).unwrap_or(room_id);

            // Remove user from any other voice channel they're currently in
            {
                let mut vc = state.voice_channels.write().await;
                let mut old_channels: Vec<(String, Vec<String>, bool)> = Vec::new();
                for (old_cid, members) in vc.iter_mut() {
                    if old_cid != channel_id {
                        if let Some(member) = members.remove(user_id) {
                            let remaining = members.keys().cloned().collect::<Vec<_>>();
                            old_channels.push((old_cid.clone(), remaining, member.screen_sharing));
                        }
                    }
                }
                drop(vc);

                for (old_cid, remaining_members, was_screen_sharing) in old_channels {
                    // Teardown old voice WebRTC connections
                    teardown_voice_subscriptions_for_listener(&state, user_id).await;
                    let _ = teardown_voice_publisher(&state, user_id).await;
                    teardown_screen_subscriptions_for_viewer(&state, user_id).await;
                    let publisher_room = teardown_screen_publisher(&state, user_id).await;

                    let leave_event = json!({
                        "type": "voice_user_left",
                        "room_id": room_id,
                        "channel_id": old_cid,
                        "user_id": user_id,
                        "voice_members": remaining_members
                    });
                    broadcast_to_room(&state, room_id, &leave_event).await;

                    if was_screen_sharing {
                        let event = json!({
                            "type": "screen_share_stopped",
                            "room_id": room_id,
                            "user_id": user_id
                        });
                        broadcast_to_room(&state, room_id, &event).await;
                    } else if let Some(ref published_room_id) = publisher_room {
                        let event = json!({
                            "type": "screen_share_stopped",
                            "room_id": published_room_id,
                            "user_id": user_id
                        });
                        broadcast_to_room(&state, published_room_id, &event).await;
                    }
                }
            }

            let voice_members = {
                let mut vc = state.voice_channels.write().await;
                let chan_vc = vc.entry(channel_id.to_string()).or_insert_with(HashMap::new);
                chan_vc.insert(
                    user_id.to_string(),
                    VoiceMemberState {
                        muted: false,
                        screen_sharing: false,
                    },
                );
                chan_vc.keys().cloned().collect::<Vec<_>>()
            };
            let event = json!({
                "type": "voice_user_joined",
                "room_id": room_id,
                "channel_id": channel_id,
                "user_id": user_id,
                "voice_members": voice_members
            });
            broadcast_to_room(&state, room_id, &event).await;

            // Send list of existing voice publishers to the new joiner
            let existing_publishers: Vec<String> = {
                let publishers = state.voice_publishers.read().await;
                let vc = state.voice_channels.read().await;
                if let Some(chan_vc) = vc.get(channel_id) {
                    chan_vc
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
                    "channel_id": channel_id,
                    "publishers": existing_publishers
                });
                send_to_user(&state, user_id, &publishers_msg).await;
            }
        }
        "voice_leave" => {
            let channel_id = msg.get("channel_id").and_then(|v| v.as_str()).unwrap_or(room_id);
            let (voice_members, was_screen_sharing) = {
                let mut vc = state.voice_channels.write().await;
                if let Some(chan_vc) = vc.get_mut(channel_id) {
                    if let Some(member) = chan_vc.remove(user_id) {
                        (
                            chan_vc.keys().cloned().collect::<Vec<_>>(),
                            member.screen_sharing,
                        )
                    } else {
                        (chan_vc.keys().cloned().collect::<Vec<_>>(), false)
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
                "channel_id": channel_id,
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
            let channel_id = msg.get("channel_id").and_then(|v| v.as_str()).unwrap_or(room_id);
            {
                let mut vc = state.voice_channels.write().await;
                if let Some(chan_vc) = vc.get_mut(channel_id) {
                    if let Some(member) = chan_vc.get_mut(user_id) {
                        member.muted = muted;
                    }
                }
            }
            let event = json!({
                "type": "voice_user_muted",
                "room_id": room_id,
                "channel_id": channel_id,
                "user_id": user_id,
                "muted": muted
            });
            broadcast_to_room(&state, room_id, &event).await;
        }
        "screen_share_start" => {
            let channel_id = msg.get("channel_id").and_then(|v| v.as_str()).unwrap_or(room_id);
            {
                let mut vc = state.voice_channels.write().await;
                if let Some(chan_vc) = vc.get_mut(channel_id) {
                    if let Some(member) = chan_vc.get_mut(user_id) {
                        member.screen_sharing = true;
                    }
                }
            }
            let event = json!({
                "type": "screen_share_started",
                "room_id": room_id,
                "channel_id": channel_id,
                "user_id": user_id
            });
            broadcast_to_room(&state, room_id, &event).await;
        }
        "screen_share_stop" => {
            let channel_id = msg.get("channel_id").and_then(|v| v.as_str()).unwrap_or(room_id);
            {
                let mut vc = state.voice_channels.write().await;
                if let Some(chan_vc) = vc.get_mut(channel_id) {
                    if let Some(member) = chan_vc.get_mut(user_id) {
                        member.screen_sharing = false;
                    }
                }
            }
            let _ = teardown_screen_publisher(&state, user_id).await;
            let event = json!({
                "type": "screen_share_stopped",
                "room_id": room_id,
                "channel_id": channel_id,
                "user_id": user_id
            });
            broadcast_to_room(&state, room_id, &event).await;
        }
        "screen_webrtc_publish_offer" => {
            let sdp = msg.get("sdp").and_then(|v| v.as_str()).unwrap_or("");
            let ch_id = msg.get("channel_id").and_then(|v| v.as_str()).unwrap_or(room_id);
            handle_screen_webrtc_publish_offer(state.clone(), user_id, room_id, ch_id, sdp).await;
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
            let ch_id = msg.get("channel_id").and_then(|v| v.as_str()).unwrap_or(room_id);
            handle_voice_webrtc_publish_offer(state.clone(), user_id, room_id, ch_id, sdp).await;
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
            // Persist to MongoDB
            let users_coll = state.db.collection::<UserRecord>("users");
            let _ = users_coll.update_one(
                doc! { "_id": user_id },
                doc! { "$set": { "custom_status": &custom_status } },
            ).await;
            let (effective_status, p_is_mobile, steam_game, steam_appid, game_session_start, spotify_track, spotify_artist, spotify_album_art) = {
                let mut up = state.user_presence.write().await;
                if let Some(p) = up.get_mut(user_id) {
                    p.custom_status = custom_status.clone();
                    let eff = match &p.manual_status {
                        Some(ms) => ms.clone(),
                        None => if now_secs() - p.last_active < 300.0 { "active".to_string() } else { "idle".to_string() },
                    };
                    (eff, p.is_mobile, p.steam_game.clone(), p.steam_appid.clone(), p.game_session_start, p.spotify_track.clone(), p.spotify_artist.clone(), p.spotify_album_art.clone())
                } else { ("active".to_string(), false, None, None, None, None, None, None) }
            };
            let (avatar_url, about, banner_url, display_name, name_font_url) = get_user_profile(&state, user_id).await;
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
                "status": effective_status,
                "custom_status": custom_status,
                "avatar_url": avatar_url,
                "about": about,
                "banner_url": banner_url,
                "display_name": display_name,
                "name_font_url": name_font_url,
                "is_mobile": p_is_mobile,
                "steam_game": steam_game,
                "steam_appid": steam_appid,
                "game_session_start": game_session_start,
                "spotify_track": spotify_track,
                "spotify_artist": spotify_artist,
                "spotify_album_art": spotify_album_art,
            });
            for rid in user_rooms {
                broadcast_to_room(&state, &rid, &event).await;
            }
        }
        "set_status" => {
            let manual_status = msg.get("status").and_then(|v| v.as_str()).map(|s| s.to_string());
            // Persist to MongoDB
            let users_coll = state.db.collection::<UserRecord>("users");
            match &manual_status {
                Some(ms) => {
                    let _ = users_coll.update_one(
                        doc! { "_id": user_id },
                        doc! { "$set": { "manual_status": ms } },
                    ).await;
                }
                None => {
                    let _ = users_coll.update_one(
                        doc! { "_id": user_id },
                        doc! { "$unset": { "manual_status": "" } },
                    ).await;
                }
            }
            let (effective_status, custom_status, p_is_mobile, steam_game, steam_appid, game_session_start, spotify_track, spotify_artist, spotify_album_art) = {
                let mut up = state.user_presence.write().await;
                if let Some(p) = up.get_mut(user_id) {
                    p.manual_status = manual_status;
                    let eff = match &p.manual_status {
                        Some(ms) => ms.clone(),
                        None => if now_secs() - p.last_active < 300.0 { "active".to_string() } else { "idle".to_string() },
                    };
                    (eff, p.custom_status.clone(), p.is_mobile, p.steam_game.clone(), p.steam_appid.clone(), p.game_session_start, p.spotify_track.clone(), p.spotify_artist.clone(), p.spotify_album_art.clone())
                } else { ("active".to_string(), String::new(), false, None, None, None, None, None, None) }
            };
            let (avatar_url, about, banner_url, display_name, name_font_url) = get_user_profile(&state, user_id).await;
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
                "status": effective_status,
                "custom_status": custom_status,
                "avatar_url": avatar_url,
                "about": about,
                "banner_url": banner_url,
                "display_name": display_name,
                "name_font_url": name_font_url,
                "is_mobile": p_is_mobile,
                "steam_game": steam_game,
                "steam_appid": steam_appid,
                "game_session_start": game_session_start,
                "spotify_track": spotify_track,
                "spotify_artist": spotify_artist,
                "spotify_album_art": spotify_album_art,
            });
            for rid in user_rooms {
                broadcast_to_room(&state, &rid, &event).await;
            }
        }
        "set_profile" => {
            // Update UserRecord in MongoDB
            let mut update_doc = mongodb::bson::Document::new();
            if let Some(avatar) = msg.get("avatar_url").and_then(|v| v.as_str()) {
                update_doc.insert("avatar_url", avatar);
            }
            if let Some(about) = msg.get("about").and_then(|v| v.as_str()) {
                update_doc.insert("about", about);
            }
            if let Some(banner) = msg.get("banner_url").and_then(|v| v.as_str()) {
                update_doc.insert("banner_url", banner);
            }
            if let Some(dn) = msg.get("display_name").and_then(|v| v.as_str()) {
                update_doc.insert("display_name", dn);
            }
            if let Some(nfu) = msg.get("name_font_url").and_then(|v| v.as_str()) {
                update_doc.insert("name_font_url", nfu);
            }
            if !update_doc.is_empty() {
                let users_coll = state.db.collection::<UserRecord>("users");
                let _ = users_coll
                    .update_one(
                        doc! { "_id": user_id },
                        doc! { "$set": update_doc },
                    )
                    .await;
            }

            // Update custom_status in PresenceRecord and MongoDB if provided
            if let Some(cs) = msg.get("custom_status").and_then(|v| v.as_str()) {
                let users_coll2 = state.db.collection::<UserRecord>("users");
                let _ = users_coll2.update_one(
                    doc! { "_id": user_id },
                    doc! { "$set": { "custom_status": cs } },
                ).await;
                let mut up = state.user_presence.write().await;
                if let Some(p) = up.get_mut(user_id) {
                    p.custom_status = cs.to_string();
                }
            }

            // Read current values for broadcast
            let (avatar_url, about, banner_url, display_name, name_font_url) = get_user_profile(&state, user_id).await;
            let (custom_status, effective_status, p_is_mobile, steam_game, steam_appid, game_session_start, spotify_track, spotify_artist, spotify_album_art) = {
                let up = state.user_presence.read().await;
                if let Some(p) = up.get(user_id) {
                    let eff = match &p.manual_status {
                        Some(ms) => ms.clone(),
                        None => if now_secs() - p.last_active < 300.0 { "active".to_string() } else { "idle".to_string() },
                    };
                    (p.custom_status.clone(), eff, p.is_mobile, p.steam_game.clone(), p.steam_appid.clone(), p.game_session_start, p.spotify_track.clone(), p.spotify_artist.clone(), p.spotify_album_art.clone())
                } else { (String::new(), "active".to_string(), false, None, None, None, None, None, None) }
            };
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
                "status": effective_status,
                "custom_status": custom_status,
                "avatar_url": avatar_url,
                "about": about,
                "banner_url": banner_url,
                "display_name": display_name,
                "name_font_url": name_font_url,
                "is_mobile": p_is_mobile,
                "steam_game": steam_game,
                "steam_appid": steam_appid,
                "game_session_start": game_session_start,
                "spotify_track": spotify_track,
                "spotify_artist": spotify_artist,
                "spotify_album_art": spotify_album_art,
            });
            for rid in user_rooms {
                broadcast_to_room(&state, &rid, &event).await;
            }
        }
        "whiteboard_stroke" => {
            if !room_id.is_empty() {
                let tool = msg.get("tool").and_then(|v| v.as_str()).unwrap_or("pen").to_string();
                let color = msg.get("color").and_then(|v| v.as_str()).unwrap_or("#000000").to_string();
                let width = msg.get("width").and_then(|v| v.as_f64()).unwrap_or(2.0);
                let fill = msg.get("fill").and_then(|v| v.as_bool()).unwrap_or(false);
                let points: Vec<Vec<f64>> = msg.get("points")
                    .and_then(|v| serde_json::from_value(v.clone()).ok())
                    .unwrap_or_default();

                let stroke_id = generate_id("stroke_");
                let now = now_millis();

                let stroke = WhiteboardStrokeRecord {
                    stroke_id: stroke_id.clone(),
                    room_id: room_id.to_string(),
                    user_id: user_id.to_string(),
                    tool: tool.clone(),
                    color: color.clone(),
                    width,
                    points: points.clone(),
                    fill,
                    timestamp: now,
                };

                let coll = state.db.collection::<WhiteboardStrokeRecord>("whiteboard_strokes");
                let _ = coll.insert_one(&stroke).await;

                let event = json!({
                    "type": "whiteboard_stroke",
                    "room_id": room_id,
                    "stroke": {
                        "stroke_id": stroke_id,
                        "user_id": user_id,
                        "tool": tool,
                        "color": color,
                        "width": width,
                        "points": points,
                        "fill": fill,
                        "timestamp": now,
                    }
                });
                broadcast_to_room(&state, room_id, &event).await;
            }
        }
        "whiteboard_cursor" => {
            if !room_id.is_empty() {
                let x = msg.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let y = msg.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let event = json!({
                    "type": "whiteboard_cursor",
                    "room_id": room_id,
                    "user_id": user_id,
                    "x": x,
                    "y": y,
                });
                broadcast_to_room(&state, room_id, &event).await;
            }
        }
        "whiteboard_clear" => {
            if !room_id.is_empty() {
                // Only owner/moderator can clear
                if is_moderator_or_owner(&state, room_id, user_id).await {
                    let coll = state.db.collection::<WhiteboardStrokeRecord>("whiteboard_strokes");
                    let _ = coll.delete_many(doc! { "room_id": room_id }).await;
                    let event = json!({
                        "type": "whiteboard_clear",
                        "room_id": room_id,
                    });
                    broadcast_to_room(&state, room_id, &event).await;
                }
            }
        }
        "whiteboard_undo" => {
            if !room_id.is_empty() {
                let coll = state.db.collection::<WhiteboardStrokeRecord>("whiteboard_strokes");
                // Find the user's most recent stroke in this room
                if let Ok(Some(stroke)) = coll
                    .find_one(doc! { "room_id": room_id, "user_id": user_id })
                    .sort(doc! { "timestamp": -1 })
                    .await
                {
                    let stroke_id = stroke.stroke_id.clone();
                    let _ = coll.delete_one(doc! { "_id": &stroke_id }).await;
                    let event = json!({
                        "type": "whiteboard_undo",
                        "room_id": room_id,
                        "user_id": user_id,
                        "stroke_id": stroke_id,
                    });
                    broadcast_to_room(&state, room_id, &event).await;
                }
            }
        }
        "tankwar_submit_script" => {
            if !room_id.is_empty() {
                let script = msg.get("script").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let coll = state.db.collection::<TankGameRecord>("tank_games");
                if let Ok(Some(mut game)) = coll
                    .find_one(doc! { "room_id": room_id, "status": "lobby" })
                    .await
                {
                    // Add player if not already in game
                    let colors = ["#ef4444", "#3b82f6", "#22c55e", "#eab308"];
                    if !game.players.iter().any(|p| p.user_id == user_id) {
                        if game.players.len() < 4 {
                            let color = colors[game.players.len() % 4].to_string();
                            let hp = if game.game_mode == "battle_royale" { 1 } else { 3 };
                            game.players.push(TankPlayer {
                                user_id: user_id.to_string(),
                                script: script.clone(),
                                ready: false,
                                x: 1, y: 1,
                                direction: "east".to_string(),
                                health: hp,
                                alive: true,
                                color,
                                score: 0,
                                hill_ticks: 0,
                            });
                        }
                    } else {
                        // Update existing script
                        for p in &mut game.players {
                            if p.user_id == user_id {
                                p.script = script.clone();
                            }
                        }
                    }
                    let _ = coll.replace_one(doc! { "_id": &game.game_id }, &game).await;
                    let event = json!({
                        "type": "tankwar_script_submitted",
                        "room_id": room_id,
                        "user_id": user_id,
                        "game_id": &game.game_id,
                    });
                    send_to_user(&state, user_id, &event).await;
                    // Broadcast player list update
                    let players_event = json!({
                        "type": "tankwar_player_joined",
                        "room_id": room_id,
                        "game_id": &game.game_id,
                        "players": game.players.iter().map(|p| json!({
                            "user_id": p.user_id,
                            "ready": p.ready,
                            "color": p.color,
                            "has_script": !p.script.is_empty(),
                        })).collect::<Vec<_>>(),
                    });
                    broadcast_to_room(&state, room_id, &players_event).await;
                }
            }
        }
        "tankwar_ready" => {
            if !room_id.is_empty() {
                let coll = state.db.collection::<TankGameRecord>("tank_games");
                if let Ok(Some(mut game)) = coll
                    .find_one(doc! { "room_id": room_id, "status": "lobby" })
                    .await
                {
                    for p in &mut game.players {
                        if p.user_id == user_id {
                            p.ready = true;
                        }
                    }
                    let _ = coll.replace_one(doc! { "_id": &game.game_id }, &game).await;
                    let event = json!({
                        "type": "tankwar_player_ready",
                        "room_id": room_id,
                        "game_id": &game.game_id,
                        "user_id": user_id,
                        "ready": true,
                        "players": game.players.iter().map(|p| json!({
                            "user_id": p.user_id,
                            "ready": p.ready,
                            "color": p.color,
                            "has_script": !p.script.is_empty(),
                        })).collect::<Vec<_>>(),
                    });
                    broadcast_to_room(&state, room_id, &event).await;

                    // Check if all players ready (need at least 1)
                    let all_ready = !game.players.is_empty()
                        && game.players.iter().all(|p| p.ready && !p.script.is_empty());
                    if all_ready {
                        let game_id = game.game_id.clone();
                        let room_id_owned = room_id.to_string();
                        let state_clone = state.clone();
                        let handle = tokio::spawn(async move {
                            tankwar_engine::run_tank_game(state_clone, room_id_owned, game_id.clone()).await;
                        });
                        state.tank_games.write().await.insert(game.game_id.clone(), handle);
                    }
                }
            }
        }
        "tankwar_unready" => {
            if !room_id.is_empty() {
                let coll = state.db.collection::<TankGameRecord>("tank_games");
                if let Ok(Some(mut game)) = coll
                    .find_one(doc! { "room_id": room_id, "status": "lobby" })
                    .await
                {
                    for p in &mut game.players {
                        if p.user_id == user_id {
                            p.ready = false;
                        }
                    }
                    let _ = coll.replace_one(doc! { "_id": &game.game_id }, &game).await;
                    let event = json!({
                        "type": "tankwar_player_ready",
                        "room_id": room_id,
                        "game_id": &game.game_id,
                        "user_id": user_id,
                        "ready": false,
                        "players": game.players.iter().map(|p| json!({
                            "user_id": p.user_id,
                            "ready": p.ready,
                            "color": p.color,
                            "has_script": !p.script.is_empty(),
                        })).collect::<Vec<_>>(),
                    });
                    broadcast_to_room(&state, room_id, &event).await;
                }
            }
        }
        "tankwar_vote_reset" => {
            if !room_id.is_empty() {
                let coll = state.db.collection::<TankGameRecord>("tank_games");
                if let Ok(Some(mut game)) = coll
                    .find_one(doc! { "room_id": room_id, "status": { "$in": ["lobby", "running"] } })
                    .await
                {
                    // Add vote if not already voted
                    if !game.reset_votes.contains(&user_id.to_string()) {
                        game.reset_votes.push(user_id.to_string());
                    }

                    let total_players = game.players.len();
                    let vote_count = game.reset_votes.len();
                    let all_voted = vote_count >= total_players && total_players > 0;

                    if all_voted {
                        // Cancel running game task if active
                        let game_id = game.game_id.clone();
                        if let Some(handle) = state.tank_games.write().await.remove(&game_id) {
                            handle.abort();
                        }
                        // Mark game as finished (reset)
                        game.status = "finished".to_string();
                        game.winner = None;
                        let _ = coll.replace_one(doc! { "_id": &game_id }, &game).await;

                        let event = json!({
                            "type": "tankwar_game_reset",
                            "room_id": room_id,
                            "game_id": &game_id,
                        });
                        broadcast_to_room(&state, room_id, &event).await;
                    } else {
                        let _ = coll.replace_one(doc! { "_id": &game.game_id }, &game).await;
                        let event = json!({
                            "type": "tankwar_reset_vote",
                            "room_id": room_id,
                            "game_id": &game.game_id,
                            "user_id": user_id,
                            "vote_count": vote_count,
                            "votes_needed": total_players,
                        });
                        broadcast_to_room(&state, room_id, &event).await;
                    }
                }
            }
        }
        "watchparty_set_video" => {
            if !room_id.is_empty() {
                let video_url = msg.get("video_url").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let is_host = {
                    let wp = state.watch_party_rooms.read().await;
                    wp.get(room_id)
                        .map(|s| s.host_user_id == user_id || s.host_user_id.is_empty() || s.video_url.is_empty())
                        .unwrap_or(true)
                };
                if is_host {
                    let now = now_secs();
                    {
                        let mut wp = state.watch_party_rooms.write().await;
                        wp.insert(room_id.to_string(), crate::backend::state::WatchPartyState {
                            video_url: video_url.clone(),
                            playing: false,
                            position_secs: 0.0,
                            position_updated_at: now,
                            host_user_id: user_id.to_string(),
                            duration_secs: 0.0,
                        });
                    }
                    let event = json!({
                        "type": "watchparty_video_changed",
                        "room_id": room_id,
                        "video_url": video_url,
                        "playing": false,
                        "position_secs": 0.0,
                        "position_updated_at": now,
                        "host_user_id": user_id,
                        "duration_secs": 0.0,
                    });
                    broadcast_to_room(&state, room_id, &event).await;
                }
            }
        }
        "watchparty_control" => {
            if !room_id.is_empty() {
                let is_host = {
                    let wp = state.watch_party_rooms.read().await;
                    wp.get(room_id).map(|s| s.host_user_id == user_id).unwrap_or(false)
                };
                if is_host {
                    let playing = msg.get("playing").and_then(|v| v.as_bool()).unwrap_or(false);
                    let position_secs = msg.get("position_secs").and_then(|v| v.as_f64()).unwrap_or(0.0);
                    let duration_secs = msg.get("duration_secs").and_then(|v| v.as_f64()).unwrap_or(0.0);
                    let now = now_secs();
                    {
                        let mut wp = state.watch_party_rooms.write().await;
                        if let Some(s) = wp.get_mut(room_id) {
                            s.playing = playing;
                            s.position_secs = position_secs;
                            s.position_updated_at = now;
                            if duration_secs > 0.0 {
                                s.duration_secs = duration_secs;
                            }
                        }
                    }
                    let stored_duration = {
                        let wp = state.watch_party_rooms.read().await;
                        wp.get(room_id).map(|s| s.duration_secs).unwrap_or(0.0)
                    };
                    let event = json!({
                        "type": "watchparty_sync",
                        "room_id": room_id,
                        "playing": playing,
                        "position_secs": position_secs,
                        "position_updated_at": now,
                        "host_user_id": user_id,
                        "duration_secs": stored_duration,
                    });
                    broadcast_to_room(&state, room_id, &event).await;
                }
            }
        }
        "watchparty_transfer_host" => {
            if !room_id.is_empty() {
                let new_host = msg.get("new_host_user_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if !new_host.is_empty() {
                    let is_host = {
                        let wp = state.watch_party_rooms.read().await;
                        wp.get(room_id).map(|s| s.host_user_id == user_id).unwrap_or(false)
                    };
                    if is_host {
                        let (playing, position_secs, position_updated_at, video_url, duration_secs) = {
                            let mut wp = state.watch_party_rooms.write().await;
                            if let Some(s) = wp.get_mut(room_id) {
                                s.host_user_id = new_host.clone();
                                (s.playing, s.position_secs, s.position_updated_at, s.video_url.clone(), s.duration_secs)
                            } else {
                                return;
                            }
                        };
                        let event = json!({
                            "type": "watchparty_sync",
                            "room_id": room_id,
                            "video_url": video_url,
                            "playing": playing,
                            "position_secs": position_secs,
                            "position_updated_at": position_updated_at,
                            "host_user_id": new_host,
                            "duration_secs": duration_secs,
                        });
                        broadcast_to_room(&state, room_id, &event).await;
                    }
                }
            }
        }
        "watchparty_request_sync" => {
            if !room_id.is_empty() {
                let wp = state.watch_party_rooms.read().await;
                if let Some(s) = wp.get(room_id) {
                    let event = json!({
                        "type": "watchparty_sync",
                        "room_id": room_id,
                        "video_url": s.video_url,
                        "playing": s.playing,
                        "position_secs": s.position_secs,
                        "position_updated_at": s.position_updated_at,
                        "host_user_id": s.host_user_id,
                        "duration_secs": s.duration_secs,
                    });
                    drop(wp);
                    send_to_user(&state, user_id, &event).await;
                }
            }
        }
        // ─── Tug of War ──────────────────────────────────────────────────────────
        "tugofwar_join_team" => {
            if !room_id.is_empty() {
                let team = msg.get("team").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if team != "left" && team != "right" { return; }
                let coll = state.db.collection::<TugOfWarGame>("tug_of_war_games");
                if let Ok(Some(mut game)) = coll.find_one(doc! { "room_id": room_id, "status": "lobby" }).await {
                    if !game.players.iter().any(|p| p.user_id == user_id) {
                        game.players.push(TugOfWarPlayer {
                            user_id: user_id.to_string(),
                            team: team.clone(),
                            ready: false,
                            chars_correct: 0,
                            errors: 0,
                            wps: 0.0,
                        });
                    } else {
                        for p in &mut game.players {
                            if p.user_id == user_id {
                                p.team = team.clone();
                                p.ready = false;
                            }
                        }
                    }
                    let _ = coll.replace_one(doc! { "_id": &game.game_id }, &game).await;
                    let event = json!({
                        "type": "tugofwar_player_update",
                        "room_id": room_id,
                        "game_id": &game.game_id,
                        "players": game.players.iter().map(|p| json!({
                            "user_id": p.user_id,
                            "team": p.team,
                            "ready": p.ready,
                        })).collect::<Vec<_>>(),
                    });
                    broadcast_to_room(&state, room_id, &event).await;
                }
            }
        }
        "tugofwar_leave_team" => {
            if !room_id.is_empty() {
                let coll = state.db.collection::<TugOfWarGame>("tug_of_war_games");
                if let Ok(Some(mut game)) = coll.find_one(doc! { "room_id": room_id, "status": "lobby" }).await {
                    for p in &mut game.players {
                        if p.user_id == user_id {
                            p.team = String::new();
                            p.ready = false;
                        }
                    }
                    let _ = coll.replace_one(doc! { "_id": &game.game_id }, &game).await;
                    let event = json!({
                        "type": "tugofwar_player_update",
                        "room_id": room_id,
                        "game_id": &game.game_id,
                        "players": game.players.iter().map(|p| json!({
                            "user_id": p.user_id,
                            "team": p.team,
                            "ready": p.ready,
                        })).collect::<Vec<_>>(),
                    });
                    broadcast_to_room(&state, room_id, &event).await;
                }
            }
        }
        "tugofwar_ready" => {
            if !room_id.is_empty() {
                let coll = state.db.collection::<TugOfWarGame>("tug_of_war_games");
                if let Ok(Some(mut game)) = coll.find_one(doc! { "room_id": room_id, "status": "lobby" }).await {
                    for p in &mut game.players {
                        if p.user_id == user_id && !p.team.is_empty() {
                            p.ready = true;
                        }
                    }
                    let has_left = game.players.iter().any(|p| p.team == "left");
                    let has_right = game.players.iter().any(|p| p.team == "right");
                    let all_ready = has_left && has_right
                        && game.players.iter().filter(|p| !p.team.is_empty()).all(|p| p.ready);

                    if all_ready {
                        game.status = "running".to_string();
                        game.started_at = Some(now_millis());
                    }
                    let _ = coll.replace_one(doc! { "_id": &game.game_id }, &game).await;

                    if all_ready {
                        let started_at = game.started_at;
                        let game_id = game.game_id.clone();
                        let room_id_owned = room_id.to_string();
                        let state_clone = state.clone();
                        let handle = tokio::spawn(async move {
                            tugofwar_engine::run_tug_of_war_game(state_clone, room_id_owned, game_id).await;
                        });
                        state.tug_of_war_games.write().await.insert(game.game_id.clone(), handle);

                        let event = json!({
                            "type": "tugofwar_game_started",
                            "room_id": room_id,
                            "game_id": &game.game_id,
                            "prompt": &game.prompt,
                            "started_at": started_at,
                            "players": game.players.iter().map(|p| json!({
                                "user_id": p.user_id,
                                "team": p.team,
                                "ready": p.ready,
                            })).collect::<Vec<_>>(),
                        });
                        broadcast_to_room(&state, room_id, &event).await;
                    } else {
                        let event = json!({
                            "type": "tugofwar_player_update",
                            "room_id": room_id,
                            "game_id": &game.game_id,
                            "players": game.players.iter().map(|p| json!({
                                "user_id": p.user_id,
                                "team": p.team,
                                "ready": p.ready,
                            })).collect::<Vec<_>>(),
                        });
                        broadcast_to_room(&state, room_id, &event).await;
                    }
                }
            }
        }
        "tugofwar_unready" => {
            if !room_id.is_empty() {
                let coll = state.db.collection::<TugOfWarGame>("tug_of_war_games");
                if let Ok(Some(mut game)) = coll.find_one(doc! { "room_id": room_id, "status": "lobby" }).await {
                    for p in &mut game.players {
                        if p.user_id == user_id {
                            p.ready = false;
                        }
                    }
                    let _ = coll.replace_one(doc! { "_id": &game.game_id }, &game).await;
                    let event = json!({
                        "type": "tugofwar_player_update",
                        "room_id": room_id,
                        "game_id": &game.game_id,
                        "players": game.players.iter().map(|p| json!({
                            "user_id": p.user_id,
                            "team": p.team,
                            "ready": p.ready,
                        })).collect::<Vec<_>>(),
                    });
                    broadcast_to_room(&state, room_id, &event).await;
                }
            }
        }
        "tugofwar_progress" => {
            if !room_id.is_empty() {
                let chars_correct = msg.get("chars_correct").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                let errors = msg.get("errors").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                let coll = state.db.collection::<TugOfWarGame>("tug_of_war_games");
                if let Ok(Some(mut game)) = coll.find_one(doc! { "room_id": room_id, "status": "running" }).await {
                    for p in &mut game.players {
                        if p.user_id == user_id {
                            p.chars_correct = chars_correct;
                            p.errors = errors;
                        }
                    }
                    let _ = coll.replace_one(doc! { "_id": &game.game_id }, &game).await;
                }
            }
        }
        "tugofwar_vote_reset" => {
            if !room_id.is_empty() {
                let coll = state.db.collection::<TugOfWarGame>("tug_of_war_games");
                if let Ok(Some(mut game)) = coll
                    .find_one(doc! { "room_id": room_id, "status": { "$in": ["lobby", "running", "finished"] } })
                    .await
                {
                    if !game.reset_votes.contains(&user_id.to_string()) {
                        game.reset_votes.push(user_id.to_string());
                    }
                    let total = game.players.len().max(1);
                    let votes = game.reset_votes.len();
                    let all_voted = votes >= total;

                    if all_voted {
                        // Abort tick task
                        if let Some(handle) = state.tug_of_war_games.write().await.remove(&game.game_id) {
                            handle.abort();
                        }
                        game.status = "finished".to_string();
                        game.winner = None;
                        let _ = coll.replace_one(doc! { "_id": &game.game_id }, &game).await;
                        let event = json!({
                            "type": "tugofwar_game_reset",
                            "room_id": room_id,
                            "game_id": &game.game_id,
                        });
                        broadcast_to_room(&state, room_id, &event).await;
                    } else {
                        let _ = coll.replace_one(doc! { "_id": &game.game_id }, &game).await;
                        let event = json!({
                            "type": "tugofwar_reset_vote",
                            "room_id": room_id,
                            "game_id": &game.game_id,
                            "user_id": user_id,
                            "vote_count": votes,
                            "votes_needed": total,
                        });
                        broadcast_to_room(&state, room_id, &event).await;
                    }
                }
            }
        }
        "heartbeat" => {}
        _ => {}
    }
}

/// Helper to get user avatar_url, about, banner_url, and display_name from MongoDB.
async fn get_user_profile(state: &AppState, user_id: &str) -> (String, String, String, String, String) {
    let users_coll = state.db.collection::<UserRecord>("users");
    match users_coll.find_one(doc! { "_id": user_id }).await {
        Ok(Some(u)) => (u.avatar_url, u.about, u.banner_url, u.display_name, u.name_font_url),
        _ => (String::new(), String::new(), String::new(), String::new(), String::new()),
    }
}

pub(crate) async fn handle_ws_binary(state: &AppState, user_id: &str, data: &[u8]) {
    if data.len() >= 6 && &data[..6] == b"AUDIO:" {
        relay_audio(state, user_id, data).await;
    } else {
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

    // Watch party host transfer
    let wp_rooms: Vec<String> = {
        let wp = state.watch_party_rooms.read().await;
        wp.iter()
            .filter(|(_, s)| s.host_user_id == user_id)
            .map(|(rid, _)| rid.clone())
            .collect()
    };
    for room_id in wp_rooms {
        let new_host = {
            let rm = state.room_members.read().await;
            rm.get(&room_id)
                .and_then(|members| members.iter().find(|uid| uid.as_str() != user_id).cloned())
        };
        let event_opt = {
            let mut wp = state.watch_party_rooms.write().await;
            if let Some(s) = wp.get_mut(&room_id) {
                if let Some(ref h) = new_host {
                    s.host_user_id = h.clone();
                }
                Some(json!({
                    "type": "watchparty_sync",
                    "room_id": room_id,
                    "video_url": s.video_url,
                    "playing": s.playing,
                    "position_secs": s.position_secs,
                    "position_updated_at": s.position_updated_at,
                    "host_user_id": s.host_user_id,
                    "duration_secs": s.duration_secs,
                }))
            } else {
                None
            }
        };
        if let Some(event) = event_opt {
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

    // Broadcast offline presence
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
            "status": "offline",
            "is_mobile": false
        });
        for rid in user_rooms {
            broadcast_to_room(state, &rid, &event).await;
        }
    }
}
