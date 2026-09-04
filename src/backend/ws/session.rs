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
        teardown_voice_subscriptions_for_speaker,
    },
    webcam_webrtc::{
        handle_webcam_webrtc_publish_candidate, handle_webcam_webrtc_publish_offer,
        handle_webcam_webrtc_subscribe_candidate, handle_webcam_webrtc_subscribe_offer,
        teardown_webcam_publisher, teardown_webcam_subscriber_pair,
        teardown_webcam_subscriptions_for_viewer,
    },
};
use crate::backend::{
    helpers::{
        broadcast_to_room, channel_permissions, generate_id, get_user_from_token, get_user_role,
        now_millis, now_secs, send_to_user,
    },
    state::{AppState, PresenceRecord, UserRecord, VoiceMemberState, WhiteboardStrokeRecord},
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

    // JWT decode — no DB call; fall back to bot token if JWT fails
    let user_id_opt = match token {
        Some(ref t) => get_user_from_token(&state, t),
        None => None,
    };

    let is_bot_connection;
    let bot_room_id: Option<String>;
    let user_id;

    if let Some(uid) = user_id_opt {
        user_id = uid;
        is_bot_connection = false;
        bot_room_id = None;
    } else {
        // Try bot token
        use crate::backend::helpers::get_bot_from_token;
        let bot = match token {
            Some(ref t) => get_bot_from_token(&state, t).await,
            None => None,
        };
        match bot {
            Some(b) => {
                user_id = format!("bot:{}", b.bot_id);
                is_bot_connection = true;
                bot_room_id = Some(b.room_id.clone());
            }
            None => {
                let _ = ws_sink
                    .send(Message::Text(
                        json!({"error": "Invalid token"}).to_string().into(),
                    ))
                    .await;
                let _ = ws_sink.close().await;
                return;
            }
        }
    };

    // Set up mpsc channel for this connection
    let conn_id: u64 = rand::random();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    let ping_tx_clone = tx.clone();

    state
        .active_websockets
        .write()
        .await
        .entry(user_id.clone())
        .or_default()
        .insert(conn_id, tx);

    // For bots: add to room_members cache so broadcast_to_room delivers messages
    if is_bot_connection {
        if let Some(ref rid) = bot_room_id {
            let mut rm = state.room_members.write().await;
            rm.entry(rid.clone()).or_default().push(user_id.clone());
        }
    }

    if !is_bot_connection {
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
            let (
                custom_status,
                presence_is_mobile,
                steam_game,
                steam_appid,
                game_session_start,
                spotify_track,
                spotify_artist,
                spotify_album_art,
            ) = {
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
                    Ok(Some(u)) => (
                        u.avatar_url,
                        u.about,
                        u.banner_url,
                        u.display_name,
                        u.name_font_url,
                    ),
                    _ => (
                        String::new(),
                        String::new(),
                        String::new(),
                        String::new(),
                        String::new(),
                    ),
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

    // Spawn periodic ping sender (every 15s) to detect dead connections
    let ping_tx = Some(ping_tx_clone);
    let ping_task = tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(15));
        interval.tick().await; // skip immediate first tick
        loop {
            interval.tick().await;
            if let Some(ref tx) = ping_tx {
                if tx
                    .send(Message::Ping(Vec::from(b"ping" as &[u8]).into()))
                    .is_err()
                {
                    break;
                }
            } else {
                break;
            }
        }
    });

    // Main receive loop — timeout if no data (including pong) for 45s
    let recv_state = state.clone();
    let recv_user_id = user_id.clone();
    let recv_timeout = std::time::Duration::from_secs(45);

    loop {
        match tokio::time::timeout(recv_timeout, ws_stream.next()).await {
            Ok(Some(Ok(msg))) => match msg {
                Message::Text(text) => {
                    handle_ws_text(recv_state.clone(), &recv_user_id, &text).await;
                }
                Message::Binary(data) => {
                    handle_ws_binary(&recv_state, &recv_user_id, &data).await;
                }
                Message::Pong(_) => {} // connection alive, reset timeout
                Message::Close(_) => break,
                _ => {}
            },
            Ok(Some(Err(_))) => break, // WebSocket error
            Ok(None) => break,         // stream ended
            Err(_) => break,           // timeout — connection dead
        }
    }

    // Disconnect cleanup
    ping_task.abort();
    cleanup_disconnect(&state, &user_id, conn_id).await;
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
            let channel_id = msg
                .get("channel_id")
                .and_then(|v| v.as_str())
                .unwrap_or(room_id);

            // The channel id arrives from the client, so every access rule has to
            // be re-checked here: membership, bans, channel visibility and the
            // connect permission. Nothing upstream has vetted it.
            {
                let is_member = {
                    let rm = state.room_members.read().await;
                    rm.get(room_id)
                        .map(|m| m.iter().any(|u| u == user_id))
                        .unwrap_or(false)
                };
                let is_banned = state
                    .banned_users
                    .read()
                    .await
                    .get(room_id)
                    .map(|banned| banned.iter().any(|u| u == user_id))
                    .unwrap_or(false);

                let mut denied = !is_member || is_banned;

                // Voice channels carry overwrites like any other, so connect is
                // judged against this channel, not just the room.
                if !denied {
                    let scope = if channel_id == room_id {
                        ""
                    } else {
                        channel_id
                    };
                    let perms = channel_permissions(&state, room_id, scope, user_id).await;
                    denied = !perms.connect || (!scope.is_empty() && !perms.view_channel);
                }

                if denied {
                    send_to_user(
                        &state,
                        user_id,
                        &json!({
                            "type": "error",
                            "error": "voice_forbidden",
                            "message": "You do not have permission to join this voice channel"
                        }),
                    )
                    .await;
                    return;
                }
            }

            // Reject if this user is already in the target channel from another device.
            {
                let vc = state.voice_channels.read().await;
                if vc
                    .get(channel_id)
                    .map(|ch| ch.contains_key(user_id))
                    .unwrap_or(false)
                {
                    send_to_user(
                        &state,
                        user_id,
                        &json!({
                            "type": "error",
                            "error": "already_in_channel",
                            "message": "You are already in this voice channel on another device"
                        }),
                    )
                    .await;
                    return;
                }
            }

            // A server mute is room-scoped and outlives channel membership, so a
            // rejoin must not hand the user their microphone back.
            let force_muted = state
                .voice_force_muted
                .read()
                .await
                .get(room_id)
                .map(|users| users.iter().any(|u| u == user_id))
                .unwrap_or(false);

            // Atomically: remove user from every other channel AND insert into the target
            // channel in one write-lock hold. This prevents a second voice_join from racing
            // in between the removal and the insert, which caused users to appear in two
            // channels simultaneously.
            let (old_channels, voice_members, channel_was_empty) = {
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
                let chan_vc = vc
                    .entry(channel_id.to_string())
                    .or_insert_with(HashMap::new);
                let channel_was_empty = chan_vc.is_empty();
                chan_vc.insert(
                    user_id.to_string(),
                    VoiceMemberState {
                        muted: force_muted,
                        deafened: false,
                        screen_sharing: false,
                        force_muted,
                    },
                );
                let voice_members = chan_vc.keys().cloned().collect::<Vec<_>>();
                (old_channels, voice_members, channel_was_empty)
            };

            // Record when this channel became occupied (0 -> 1 members)
            let occupied_since_ms = if channel_was_empty {
                let now_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64;
                state
                    .voice_channel_occupied_since
                    .write()
                    .await
                    .insert(channel_id.to_string(), now_ms);
                now_ms
            } else {
                state
                    .voice_channel_occupied_since
                    .read()
                    .await
                    .get(channel_id)
                    .copied()
                    .unwrap_or(0)
            };

            // Teardowns and broadcasts happen after the lock is released
            for (old_cid, remaining_members, was_screen_sharing) in old_channels {
                teardown_voice_subscriptions_for_listener(&state, user_id).await;
                let _ = teardown_voice_publisher(&state, user_id).await;
                teardown_screen_subscriptions_for_viewer(&state, user_id).await;
                let publisher_room = teardown_screen_publisher(&state, user_id).await;
                teardown_webcam_subscriptions_for_viewer(&state, user_id).await;
                let webcam_pub_room = teardown_webcam_publisher(&state, user_id).await;

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
                if let Some(ref webcam_room_id) = webcam_pub_room {
                    let event = json!({
                        "type": "webcam_share_stopped",
                        "room_id": webcam_room_id,
                        "user_id": user_id
                    });
                    broadcast_to_room(&state, webcam_room_id, &event).await;
                }
            }

            let event = json!({
                "type": "voice_user_joined",
                "room_id": room_id,
                "channel_id": channel_id,
                "user_id": user_id,
                "voice_members": voice_members,
                "force_muted": force_muted,
                "occupied_since": occupied_since_ms
            });
            broadcast_to_room(&state, room_id, &event).await;

            // Send list of existing voice publishers to the new joiner.
            // Only include publishers whose audio track is already ready (has codec).
            // Publishers still negotiating will send publisher_ready when their
            // track arrives, triggering subscription at that point.
            let existing_publishers: Vec<String> = {
                let publishers = state.voice_publishers.read().await;
                let vc = state.voice_channels.read().await;
                if let Some(chan_vc) = vc.get(channel_id) {
                    chan_vc
                        .keys()
                        .filter(|uid| {
                            uid.as_str() != user_id
                                && publishers
                                    .get(*uid)
                                    .is_some_and(|p| p.audio_codec.is_some())
                        })
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
            let channel_id = msg
                .get("channel_id")
                .and_then(|v| v.as_str())
                .unwrap_or(room_id);
            let result = {
                let mut vc = state.voice_channels.write().await;
                if let Some(chan_vc) = vc.get_mut(channel_id) {
                    chan_vc.remove(user_id).map(|member| {
                        (
                            chan_vc.keys().cloned().collect::<Vec<_>>(),
                            member.screen_sharing,
                        )
                    })
                } else {
                    None
                }
            };

            // Only teardown and broadcast if the user was actually in this channel.
            // If result is None the user already left (e.g. via voice_join switching
            // channels), so doing nothing avoids tearing down the new connection.
            if let Some((voice_members, was_screen_sharing)) = result {
                teardown_voice_subscriptions_for_listener(&state, user_id).await;
                let _ = teardown_voice_publisher(&state, user_id).await;
                teardown_screen_subscriptions_for_viewer(&state, user_id).await;
                let publisher_room = teardown_screen_publisher(&state, user_id).await;
                teardown_webcam_subscriptions_for_viewer(&state, user_id).await;
                let webcam_publisher_room = teardown_webcam_publisher(&state, user_id).await;

                // Clear occupied_since when channel empties
                let occupied_since_ms: Option<u64> = if voice_members.is_empty() {
                    state
                        .voice_channel_occupied_since
                        .write()
                        .await
                        .remove(channel_id);
                    None
                } else {
                    state
                        .voice_channel_occupied_since
                        .read()
                        .await
                        .get(channel_id)
                        .copied()
                };

                let event = json!({
                    "type": "voice_user_left",
                    "room_id": room_id,
                    "channel_id": channel_id,
                    "user_id": user_id,
                    "voice_members": voice_members,
                    "occupied_since": occupied_since_ms
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
                if let Some(webcam_room_id) = webcam_publisher_room {
                    let event = json!({
                        "type": "webcam_share_stopped",
                        "room_id": webcam_room_id,
                        "user_id": user_id
                    });
                    broadcast_to_room(&state, &webcam_room_id, &event).await;
                }
            }
        }
        "voice_mute" => {
            let muted = msg.get("muted").and_then(|v| v.as_bool()).unwrap_or(false);
            let channel_id = msg
                .get("channel_id")
                .and_then(|v| v.as_str())
                .unwrap_or(room_id);
            // A moderator's mute wins: self-unmute is ignored while it is set.
            let muted = {
                let mut vc = state.voice_channels.write().await;
                match vc.get_mut(channel_id).and_then(|c| c.get_mut(user_id)) {
                    Some(member) if member.force_muted => true,
                    Some(member) => {
                        member.muted = muted;
                        muted
                    }
                    None => muted,
                }
            };
            let event = json!({
                "type": "voice_user_muted",
                "room_id": room_id,
                "channel_id": channel_id,
                "user_id": user_id,
                "muted": muted
            });
            broadcast_to_room(&state, room_id, &event).await;
        }
        // ─── Voice moderation ────────────────────────────────────────────────
        // Owners and moderators acting on another member's voice session:
        // server mute, move between channels, or disconnect outright.
        "voice_moderate" => {
            let action = msg.get("action").and_then(|v| v.as_str()).unwrap_or("");
            let target = msg
                .get("target_user_id")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if room_id.is_empty() || target.is_empty() {
                return;
            }

            let role = get_user_role(&state, room_id, user_id).await;
            if role != "owner" && role != "moderator" {
                send_to_user(
                    &state,
                    user_id,
                    &json!({
                        "type": "error",
                        "error": "forbidden",
                        "message": "Only owners and moderators can moderate voice"
                    }),
                )
                .await;
                return;
            }
            // A moderator cannot act on an owner; nobody needs to act on themselves.
            let target_role = get_user_role(&state, room_id, target).await;
            if target == user_id || (target_role == "owner" && role != "owner") {
                return;
            }

            match action {
                "mute" | "unmute" => {
                    let force_muted = action == "mute";
                    {
                        let mut fm = state.voice_force_muted.write().await;
                        let users = fm.entry(room_id.to_string()).or_default();
                        users.retain(|u| u != target);
                        if force_muted {
                            users.push(target.to_string());
                        }
                    }
                    let mut channel_id = String::new();
                    {
                        let mut vc = state.voice_channels.write().await;
                        for (cid, members) in vc.iter_mut() {
                            if let Some(member) = members.get_mut(target) {
                                member.force_muted = force_muted;
                                // Lifting a server mute does not unmute them —
                                // they choose when to speak again.
                                if force_muted {
                                    member.muted = true;
                                }
                                channel_id = cid.clone();
                            }
                        }
                    }
                    // Cut the audio at the SFU rather than trusting the client to.
                    if force_muted {
                        let _ = teardown_voice_publisher(&state, target).await;
                    }

                    broadcast_to_room(
                        &state,
                        room_id,
                        &json!({
                            "type": "voice_user_muted",
                            "room_id": room_id,
                            "channel_id": channel_id,
                            "user_id": target,
                            "muted": force_muted,
                            "force_muted": force_muted,
                            "by": user_id,
                        }),
                    )
                    .await;
                    // Tells the target's client to drop or rebuild its publisher.
                    send_to_user(
                        &state,
                        target,
                        &json!({
                            "type": "voice_force_muted",
                            "room_id": room_id,
                            "channel_id": channel_id,
                            "force_muted": force_muted,
                        }),
                    )
                    .await;
                }
                "move" => {
                    let target_channel = msg
                        .get("target_channel_id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    if target_channel.is_empty() {
                        return;
                    }

                    let (old_channel, moved, new_members) = {
                        let mut vc = state.voice_channels.write().await;
                        let mut old_channel = String::new();
                        let mut moved_state: Option<VoiceMemberState> = None;
                        for (cid, members) in vc.iter_mut() {
                            if cid == target_channel {
                                continue;
                            }
                            if let Some(member) = members.remove(target) {
                                old_channel = cid.clone();
                                moved_state = Some(member);
                            }
                        }
                        match moved_state {
                            Some(member) => {
                                let chan = vc
                                    .entry(target_channel.to_string())
                                    .or_insert_with(HashMap::new);
                                chan.insert(target.to_string(), member);
                                let members = chan.keys().cloned().collect::<Vec<_>>();
                                (old_channel, true, members)
                            }
                            None => (old_channel, false, Vec::new()),
                        }
                    };
                    if !moved {
                        return; // not in voice
                    }

                    // The peer mesh is per channel, so every existing pairing
                    // for this user is stale after the move.
                    teardown_voice_subscriptions_for_listener(&state, target).await;
                    let _ = teardown_voice_publisher(&state, target).await;

                    let remaining = {
                        let vc = state.voice_channels.read().await;
                        vc.get(&old_channel)
                            .map(|m| m.keys().cloned().collect::<Vec<_>>())
                            .unwrap_or_default()
                    };
                    // Emptying a channel stops its occupancy clock; leaving the
                    // stale timestamp makes the next joiner show a bogus timer.
                    if remaining.is_empty() {
                        state
                            .voice_channel_occupied_since
                            .write()
                            .await
                            .remove(&old_channel);
                    }
                    broadcast_to_room(
                        &state,
                        room_id,
                        &json!({
                            "type": "voice_user_left",
                            "room_id": room_id,
                            "channel_id": old_channel,
                            "user_id": target,
                            "voice_members": remaining,
                        }),
                    )
                    .await;
                    broadcast_to_room(
                        &state,
                        room_id,
                        &json!({
                            "type": "voice_user_joined",
                            "room_id": room_id,
                            "channel_id": target_channel,
                            "user_id": target,
                            "voice_members": new_members,
                        }),
                    )
                    .await;
                    // The target has to rebuild its peer connections for the new
                    // channel; the server cannot do that on its behalf.
                    send_to_user(
                        &state,
                        target,
                        &json!({
                            "type": "voice_force_moved",
                            "room_id": room_id,
                            "channel_id": target_channel,
                            "by": user_id,
                        }),
                    )
                    .await;
                }
                "disconnect" => {
                    let (old_channel, was_in_voice) = {
                        let mut vc = state.voice_channels.write().await;
                        let mut old_channel = String::new();
                        let mut found = false;
                        for (cid, members) in vc.iter_mut() {
                            if members.remove(target).is_some() {
                                old_channel = cid.clone();
                                found = true;
                            }
                        }
                        (old_channel, found)
                    };
                    if !was_in_voice {
                        return;
                    }

                    teardown_voice_subscriptions_for_listener(&state, target).await;
                    teardown_voice_subscriptions_for_speaker(&state, target).await;
                    let _ = teardown_voice_publisher(&state, target).await;
                    teardown_screen_subscriptions_for_viewer(&state, target).await;
                    let _ = teardown_screen_publisher(&state, target).await;
                    teardown_webcam_subscriptions_for_viewer(&state, target).await;
                    let _ = teardown_webcam_publisher(&state, target).await;

                    let remaining = {
                        let vc = state.voice_channels.read().await;
                        vc.get(&old_channel)
                            .map(|m| m.keys().cloned().collect::<Vec<_>>())
                            .unwrap_or_default()
                    };
                    if remaining.is_empty() {
                        state
                            .voice_channel_occupied_since
                            .write()
                            .await
                            .remove(&old_channel);
                    }
                    broadcast_to_room(
                        &state,
                        room_id,
                        &json!({
                            "type": "voice_user_left",
                            "room_id": room_id,
                            "channel_id": old_channel,
                            "user_id": target,
                            "voice_members": remaining,
                        }),
                    )
                    .await;
                    send_to_user(
                        &state,
                        target,
                        &json!({
                            "type": "voice_force_disconnected",
                            "room_id": room_id,
                            "channel_id": old_channel,
                            "by": user_id,
                        }),
                    )
                    .await;
                }
                _ => {}
            }
        }
        "voice_deafen" => {
            let deafened = msg
                .get("deafened")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let channel_id = msg
                .get("channel_id")
                .and_then(|v| v.as_str())
                .unwrap_or(room_id);
            {
                let mut vc = state.voice_channels.write().await;
                if let Some(chan_vc) = vc.get_mut(channel_id) {
                    if let Some(member) = chan_vc.get_mut(user_id) {
                        member.deafened = deafened;
                    }
                }
            }
            let event = json!({
                "type": "voice_user_deafened",
                "room_id": room_id,
                "channel_id": channel_id,
                "user_id": user_id,
                "deafened": deafened
            });
            broadcast_to_room(&state, room_id, &event).await;
        }
        "screen_share_start" => {
            let channel_id = msg
                .get("channel_id")
                .and_then(|v| v.as_str())
                .unwrap_or(room_id);
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
            let channel_id = msg
                .get("channel_id")
                .and_then(|v| v.as_str())
                .unwrap_or(room_id);
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
            let ch_id = msg
                .get("channel_id")
                .and_then(|v| v.as_str())
                .unwrap_or(room_id);
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
        "webcam_share_start" => {
            let channel_id = msg
                .get("channel_id")
                .and_then(|v| v.as_str())
                .unwrap_or(room_id);
            let event = json!({
                "type": "webcam_share_started",
                "room_id": room_id,
                "channel_id": channel_id,
                "user_id": user_id
            });
            broadcast_to_room(&state, room_id, &event).await;
        }
        "webcam_share_stop" => {
            let channel_id = msg
                .get("channel_id")
                .and_then(|v| v.as_str())
                .unwrap_or(room_id);
            let _ = teardown_webcam_publisher(&state, user_id).await;
            let event = json!({
                "type": "webcam_share_stopped",
                "room_id": room_id,
                "channel_id": channel_id,
                "user_id": user_id
            });
            broadcast_to_room(&state, room_id, &event).await;
        }
        "webcam_webrtc_publish_offer" => {
            let sdp = msg.get("sdp").and_then(|v| v.as_str()).unwrap_or("");
            let ch_id = msg
                .get("channel_id")
                .and_then(|v| v.as_str())
                .unwrap_or(room_id);
            handle_webcam_webrtc_publish_offer(state.clone(), user_id, room_id, ch_id, sdp).await;
        }
        "webcam_webrtc_publish_candidate" => {
            if let Some(candidate_value) = msg.get("candidate") {
                handle_webcam_webrtc_publish_candidate(&state, user_id, candidate_value).await;
            }
        }
        "webcam_webrtc_subscribe_offer" => {
            let sdp = msg.get("sdp").and_then(|v| v.as_str()).unwrap_or("");
            let sharer_user_id = msg
                .get("sharer_user_id")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            handle_webcam_webrtc_subscribe_offer(
                state.clone(),
                user_id,
                room_id,
                sharer_user_id,
                sdp,
            )
            .await;
        }
        "webcam_webrtc_subscribe_candidate" => {
            let sharer_user_id = msg
                .get("sharer_user_id")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if let Some(candidate_value) = msg.get("candidate") {
                handle_webcam_webrtc_subscribe_candidate(
                    &state,
                    user_id,
                    sharer_user_id,
                    candidate_value,
                )
                .await;
            }
        }
        "webcam_webrtc_unsubscribe" => {
            let sharer_user_id = msg
                .get("sharer_user_id")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if !sharer_user_id.is_empty() {
                teardown_webcam_subscriber_pair(&state, user_id, sharer_user_id).await;
            }
        }
        "voice_webrtc_publish_offer" => {
            let sdp = msg.get("sdp").and_then(|v| v.as_str()).unwrap_or("");
            let ch_id = msg
                .get("channel_id")
                .and_then(|v| v.as_str())
                .unwrap_or(room_id);
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
            let _ = users_coll
                .update_one(
                    doc! { "_id": user_id },
                    doc! { "$set": { "custom_status": &custom_status } },
                )
                .await;
            let (
                effective_status,
                p_is_mobile,
                steam_game,
                steam_appid,
                game_session_start,
                spotify_track,
                spotify_artist,
                spotify_album_art,
            ) = {
                let mut up = state.user_presence.write().await;
                if let Some(p) = up.get_mut(user_id) {
                    p.custom_status = custom_status.clone();
                    let eff = match &p.manual_status {
                        Some(ms) => ms.clone(),
                        None => {
                            if now_secs() - p.last_active < 300.0 {
                                "active".to_string()
                            } else {
                                "idle".to_string()
                            }
                        }
                    };
                    (
                        eff,
                        p.is_mobile,
                        p.steam_game.clone(),
                        p.steam_appid.clone(),
                        p.game_session_start,
                        p.spotify_track.clone(),
                        p.spotify_artist.clone(),
                        p.spotify_album_art.clone(),
                    )
                } else {
                    (
                        "active".to_string(),
                        false,
                        None,
                        None,
                        None,
                        None,
                        None,
                        None,
                    )
                }
            };
            let (avatar_url, about, banner_url, display_name, name_font_url) =
                get_user_profile(&state, user_id).await;
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
            let manual_status = msg
                .get("status")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            // Persist to MongoDB
            let users_coll = state.db.collection::<UserRecord>("users");
            match &manual_status {
                Some(ms) => {
                    let _ = users_coll
                        .update_one(
                            doc! { "_id": user_id },
                            doc! { "$set": { "manual_status": ms } },
                        )
                        .await;
                }
                None => {
                    let _ = users_coll
                        .update_one(
                            doc! { "_id": user_id },
                            doc! { "$unset": { "manual_status": "" } },
                        )
                        .await;
                }
            }
            let (
                effective_status,
                custom_status,
                p_is_mobile,
                steam_game,
                steam_appid,
                game_session_start,
                spotify_track,
                spotify_artist,
                spotify_album_art,
            ) = {
                let mut up = state.user_presence.write().await;
                if let Some(p) = up.get_mut(user_id) {
                    p.manual_status = manual_status;
                    let eff = match &p.manual_status {
                        Some(ms) => ms.clone(),
                        None => {
                            if now_secs() - p.last_active < 300.0 {
                                "active".to_string()
                            } else {
                                "idle".to_string()
                            }
                        }
                    };
                    (
                        eff,
                        p.custom_status.clone(),
                        p.is_mobile,
                        p.steam_game.clone(),
                        p.steam_appid.clone(),
                        p.game_session_start,
                        p.spotify_track.clone(),
                        p.spotify_artist.clone(),
                        p.spotify_album_art.clone(),
                    )
                } else {
                    (
                        "active".to_string(),
                        String::new(),
                        false,
                        None,
                        None,
                        None,
                        None,
                        None,
                        None,
                    )
                }
            };
            let (avatar_url, about, banner_url, display_name, name_font_url) =
                get_user_profile(&state, user_id).await;
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
                    .update_one(doc! { "_id": user_id }, doc! { "$set": update_doc })
                    .await;
            }

            // Update custom_status in PresenceRecord and MongoDB if provided
            if let Some(cs) = msg.get("custom_status").and_then(|v| v.as_str()) {
                let users_coll2 = state.db.collection::<UserRecord>("users");
                let _ = users_coll2
                    .update_one(
                        doc! { "_id": user_id },
                        doc! { "$set": { "custom_status": cs } },
                    )
                    .await;
                let mut up = state.user_presence.write().await;
                if let Some(p) = up.get_mut(user_id) {
                    p.custom_status = cs.to_string();
                }
            }

            // Read current values for broadcast
            let (avatar_url, about, banner_url, display_name, name_font_url) =
                get_user_profile(&state, user_id).await;
            let (
                custom_status,
                effective_status,
                p_is_mobile,
                steam_game,
                steam_appid,
                game_session_start,
                spotify_track,
                spotify_artist,
                spotify_album_art,
            ) = {
                let up = state.user_presence.read().await;
                if let Some(p) = up.get(user_id) {
                    let eff = match &p.manual_status {
                        Some(ms) => ms.clone(),
                        None => {
                            if now_secs() - p.last_active < 300.0 {
                                "active".to_string()
                            } else {
                                "idle".to_string()
                            }
                        }
                    };
                    (
                        p.custom_status.clone(),
                        eff,
                        p.is_mobile,
                        p.steam_game.clone(),
                        p.steam_appid.clone(),
                        p.game_session_start,
                        p.spotify_track.clone(),
                        p.spotify_artist.clone(),
                        p.spotify_album_art.clone(),
                    )
                } else {
                    (
                        String::new(),
                        "active".to_string(),
                        false,
                        None,
                        None,
                        None,
                        None,
                        None,
                        None,
                    )
                }
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
                let channel_id = msg
                    .get("channel_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let tool = msg
                    .get("tool")
                    .and_then(|v| v.as_str())
                    .unwrap_or("pen")
                    .to_string();
                let color = msg
                    .get("color")
                    .and_then(|v| v.as_str())
                    .unwrap_or("#000000")
                    .to_string();
                let width = msg.get("width").and_then(|v| v.as_f64()).unwrap_or(2.0);
                let fill = msg.get("fill").and_then(|v| v.as_bool()).unwrap_or(false);
                let points: Vec<Vec<f64>> = msg
                    .get("points")
                    .and_then(|v| serde_json::from_value(v.clone()).ok())
                    .unwrap_or_default();

                let stroke_id = generate_id("stroke_");
                let now = now_millis();

                let stroke = WhiteboardStrokeRecord {
                    stroke_id: stroke_id.clone(),
                    room_id: room_id.to_string(),
                    channel_id: channel_id.clone(),
                    user_id: user_id.to_string(),
                    tool: tool.clone(),
                    color: color.clone(),
                    width,
                    points: points.clone(),
                    fill,
                    timestamp: now,
                };

                let coll = state
                    .db
                    .collection::<WhiteboardStrokeRecord>("whiteboard_strokes");
                let _ = coll.insert_one(&stroke).await;

                let event = json!({
                    "type": "whiteboard_stroke",
                    "room_id": room_id,
                    "stroke": {
                        "stroke_id": stroke_id,
                        "channel_id": channel_id,
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
                let channel_id = msg
                    .get("channel_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let x = msg.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let y = msg.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let event = json!({
                    "type": "whiteboard_cursor",
                    "room_id": room_id,
                    "channel_id": channel_id,
                    "user_id": user_id,
                    "x": x,
                    "y": y,
                });
                broadcast_to_room(&state, room_id, &event).await;
            }
        }
        "whiteboard_clear" => {
            if !room_id.is_empty() {
                let channel_id = msg
                    .get("channel_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let coll = state
                    .db
                    .collection::<WhiteboardStrokeRecord>("whiteboard_strokes");
                let _ = coll
                    .delete_many(doc! { "room_id": room_id, "channel_id": &channel_id })
                    .await;
                let event = json!({
                    "type": "whiteboard_clear",
                    "room_id": room_id,
                    "channel_id": channel_id,
                });
                broadcast_to_room(&state, room_id, &event).await;
            }
        }
        "whiteboard_undo" => {
            if !room_id.is_empty() {
                let channel_id = msg
                    .get("channel_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let stroke_id = msg
                    .get("stroke_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if !stroke_id.is_empty() {
                    let coll = state
                        .db
                        .collection::<WhiteboardStrokeRecord>("whiteboard_strokes");
                    // Delete by _id + user_id to prevent deleting other users' strokes
                    let result = coll
                        .delete_one(doc! { "_id": &stroke_id, "user_id": user_id })
                        .await;
                    if result.map(|r| r.deleted_count).unwrap_or(0) > 0 {
                        let event = json!({
                            "type": "whiteboard_undo",
                            "room_id": room_id,
                            "channel_id": channel_id,
                            "user_id": user_id,
                            "stroke_id": stroke_id,
                        });
                        broadcast_to_room(&state, room_id, &event).await;
                    }
                }
            }
        }
        "watchparty_set_video" => {
            if !room_id.is_empty() {
                let video_url = msg
                    .get("video_url")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let channel_id = msg
                    .get("channel_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let now = now_secs();
                {
                    let mut wp = state.watch_party_rooms.write().await;
                    let previous_viewers = wp
                        .get(room_id)
                        .map(|s| s.viewers.clone())
                        .unwrap_or_default();
                    wp.insert(
                        room_id.to_string(),
                        crate::backend::state::WatchPartyState {
                            channel_id: channel_id.clone(),
                            video_url: video_url.clone(),
                            playing: false,
                            position_secs: 0.0,
                            position_updated_at: now,
                            duration_secs: 0.0,
                            viewers: previous_viewers,
                        },
                    );
                }
                let event = json!({
                    "type": "watchparty_video_changed",
                    "room_id": room_id,
                    "video_url": video_url,
                    "playing": false,
                    "position_secs": 0.0,
                    "position_updated_at": now,
                    "sender_user_id": user_id,
                    "duration_secs": 0.0,
                });
                broadcast_to_room(&state, room_id, &event).await;

                let display = user_id
                    .split(':')
                    .next()
                    .unwrap_or(user_id)
                    .trim_start_matches('@');
                let body = format!("{} changed the video", display);
                let mut sys_event = json!({
                    "type": "m.room.message",
                    "room_id": room_id,
                    "sender": user_id,
                    "content": {
                        "msgtype": "m.watchparty",
                        "body": body
                    },
                    "event_id": generate_id("$"),
                    "origin_server_ts": now_millis()
                });
                if !channel_id.is_empty() {
                    sys_event["channel_id"] = json!(channel_id);
                }
                let msg_col = state.db.collection::<mongodb::bson::Document>("messages");
                if let Ok(doc) = mongodb::bson::to_document(&sys_event) {
                    let _ = msg_col.insert_one(doc).await;
                }
                broadcast_to_room(&state, room_id, &sys_event).await;
            }
        }
        "watchparty_control" => {
            if !room_id.is_empty() {
                let (stored_channel_id, prev_playing, prev_pos, prev_updated_at) = {
                    let wp = state.watch_party_rooms.read().await;
                    wp.get(room_id)
                        .map(|s| {
                            (
                                s.channel_id.clone(),
                                s.playing,
                                s.position_secs,
                                s.position_updated_at,
                            )
                        })
                        .unwrap_or_default()
                };
                let playing = msg
                    .get("playing")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let position_secs = msg
                    .get("position_secs")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.0);
                let duration_secs = msg
                    .get("duration_secs")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.0);
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
                    "sender_user_id": user_id,
                    "duration_secs": stored_duration,
                });
                broadcast_to_room(&state, room_id, &event).await;

                // Determine action type to send a chat notification
                let play_state_changed = playing != prev_playing;
                let expected_pos = if prev_playing {
                    prev_pos + (now - prev_updated_at)
                } else {
                    prev_pos
                };
                let pos_jumped = (position_secs - expected_pos).abs() > 3.0;
                let is_seek = !play_state_changed && pos_jumped;
                let is_heartbeat = !play_state_changed && !pos_jumped;

                if !is_heartbeat {
                    let display = user_id
                        .split(':')
                        .next()
                        .unwrap_or(user_id)
                        .trim_start_matches('@');
                    let fmt_time = |secs: f64| -> String {
                        let total = secs as u64;
                        let h = total / 3600;
                        let m = (total % 3600) / 60;
                        let s = total % 60;
                        if h > 0 {
                            format!("{}:{:02}:{:02}", h, m, s)
                        } else {
                            format!("{}:{:02}", m, s)
                        }
                    };
                    let body = if is_seek {
                        format!("{} skipped to {}", display, fmt_time(position_secs))
                    } else if playing {
                        format!("{} resumed the video", display)
                    } else {
                        format!(
                            "{} paused the video at {}",
                            display,
                            fmt_time(position_secs)
                        )
                    };
                    let mut sys_event = json!({
                        "type": "m.room.message",
                        "room_id": room_id,
                        "sender": user_id,
                        "content": {
                            "msgtype": "m.watchparty",
                            "body": body
                        },
                        "event_id": generate_id("$"),
                        "origin_server_ts": now_millis()
                    });
                    if !stored_channel_id.is_empty() {
                        sys_event["channel_id"] = json!(stored_channel_id);
                    }
                    let msg_col = state.db.collection::<mongodb::bson::Document>("messages");
                    if let Ok(doc) = mongodb::bson::to_document(&sys_event) {
                        let _ = msg_col.insert_one(doc).await;
                    }
                    broadcast_to_room(&state, room_id, &sys_event).await;
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
                        "duration_secs": s.duration_secs,
                    });
                    drop(wp);
                    send_to_user(&state, user_id, &event).await;
                }
            }
        }
        "watchparty_viewer_join" => {
            if !room_id.is_empty() {
                let viewers = {
                    let mut wp = state.watch_party_rooms.write().await;
                    let entry = wp
                        .entry(room_id.to_string())
                        .or_insert_with(Default::default);
                    if !entry.viewers.iter().any(|v| v == user_id) {
                        entry.viewers.push(user_id.to_string());
                    }
                    entry.viewers.clone()
                };
                let event = json!({
                    "type": "watchparty_viewer_joined",
                    "room_id": room_id,
                    "user_id": user_id,
                    "viewers": viewers,
                });
                broadcast_to_room(&state, room_id, &event).await;
            }
        }
        "watchparty_viewer_leave" => {
            if !room_id.is_empty() {
                let viewers = {
                    let mut wp = state.watch_party_rooms.write().await;
                    if let Some(entry) = wp.get_mut(room_id) {
                        entry.viewers.retain(|v| v != user_id);
                        entry.viewers.clone()
                    } else {
                        Vec::new()
                    }
                };
                let event = json!({
                    "type": "watchparty_viewer_left",
                    "room_id": room_id,
                    "user_id": user_id,
                    "viewers": viewers,
                });
                broadcast_to_room(&state, room_id, &event).await;
            }
        }
        "heartbeat" => {}
        "embed_interaction" => {
            // User clicked a button or used a select on a bot embed.
            // Validate the user is in the room, then broadcast to room so the bot receives it.
            let event_id = msg.get("event_id").and_then(|v| v.as_str()).unwrap_or("");
            let component_id = msg
                .get("component_id")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let component_type = msg
                .get("component_type")
                .and_then(|v| v.as_str())
                .unwrap_or("button");
            let values = msg.get("values").cloned().unwrap_or(json!([]));

            if !event_id.is_empty() && !component_id.is_empty() && !room_id.is_empty() {
                let in_room = {
                    let rm = state.room_members.read().await;
                    rm.get(room_id)
                        .map(|m| m.contains(&user_id.to_string()))
                        .unwrap_or(false)
                };
                if in_room {
                    let interaction_event = json!({
                        "type": "m.embed_interaction",
                        "room_id": room_id,
                        "event_id": event_id,
                        "sender": user_id,
                        "component_id": component_id,
                        "component_type": component_type,
                        "values": values,
                        "origin_server_ts": now_millis(),
                    });
                    broadcast_to_room(&state, room_id, &interaction_event).await;
                }
            }
        }
        _ => {}
    }
}

/// Helper to get user avatar_url, about, banner_url, and display_name from MongoDB.
async fn get_user_profile(
    state: &AppState,
    user_id: &str,
) -> (String, String, String, String, String) {
    let users_coll = state.db.collection::<UserRecord>("users");
    match users_coll.find_one(doc! { "_id": user_id }).await {
        Ok(Some(u)) => (
            u.avatar_url,
            u.about,
            u.banner_url,
            u.display_name,
            u.name_font_url,
        ),
        _ => (
            String::new(),
            String::new(),
            String::new(),
            String::new(),
            String::new(),
        ),
    }
}

pub(crate) async fn handle_ws_binary(state: &AppState, user_id: &str, data: &[u8]) {
    // Every binary frame is relayed verbatim; relay_audio does not inspect any
    // prefix, so there is nothing to branch on.
    relay_audio(state, user_id, data).await;
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
                    if let Some(conns) = ws_map.get(mid) {
                        for tx in conns.values() {
                            let _ = tx.send(Message::Binary(data.to_vec().into()));
                        }
                    }
                }
                return;
            }
        }
    }
}

pub(crate) async fn cleanup_disconnect(state: &AppState, user_id: &str, conn_id: u64) {
    // Teardown voice WebRTC
    teardown_voice_subscriptions_for_listener(state, user_id).await;
    let _ = teardown_voice_publisher(state, user_id).await;

    teardown_screen_subscriptions_for_viewer(state, user_id).await;
    let publisher_room = teardown_screen_publisher(state, user_id).await;

    teardown_webcam_subscriptions_for_viewer(state, user_id).await;
    let webcam_publisher_room = teardown_webcam_publisher(state, user_id).await;

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

    // Remove from watch-party viewer lists and broadcast the updated lists
    let watchparty_viewer_updates: Vec<(String, Vec<String>)> = {
        let mut wp = state.watch_party_rooms.write().await;
        let mut results = Vec::new();
        for (room_id, wp_state) in wp.iter_mut() {
            if wp_state.viewers.iter().any(|v| v == user_id) {
                wp_state.viewers.retain(|v| v != user_id);
                results.push((room_id.clone(), wp_state.viewers.clone()));
            }
        }
        results
    };
    for (room_id, viewers) in watchparty_viewer_updates {
        let event = json!({
            "type": "watchparty_viewer_left",
            "room_id": room_id,
            "user_id": user_id,
            "viewers": viewers,
        });
        broadcast_to_room(state, &room_id, &event).await;
    }

    let mut stopped_screen_rooms = HashSet::new();

    for (room_or_channel_id, was_screen_sharing, voice_members) in voice_rooms {
        // Clear occupied_since if channel is now empty
        let occupied_since_ms: Option<u64> = if voice_members.is_empty() {
            state
                .voice_channel_occupied_since
                .write()
                .await
                .remove(&room_or_channel_id);
            None
        } else {
            state
                .voice_channel_occupied_since
                .read()
                .await
                .get(&room_or_channel_id)
                .copied()
        };

        let event = json!({
            "type": "voice_user_left",
            "room_id": room_or_channel_id,
            "channel_id": room_or_channel_id,
            "user_id": user_id,
            "voice_members": voice_members,
            "occupied_since": occupied_since_ms
        });
        broadcast_to_room(state, &room_or_channel_id, &event).await;

        if was_screen_sharing {
            let event = json!({
                "type": "screen_share_stopped",
                "room_id": room_or_channel_id,
                "user_id": user_id
            });
            broadcast_to_room(state, &room_or_channel_id, &event).await;
            stopped_screen_rooms.insert(room_or_channel_id);
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

    if let Some(room_id) = webcam_publisher_room {
        let event = json!({
            "type": "webcam_share_stopped",
            "room_id": room_id,
            "user_id": user_id
        });
        broadcast_to_room(state, &room_id, &event).await;
    }

    // Remove this specific connection; check whether any remain.
    let still_connected = {
        let mut ws_map = state.active_websockets.write().await;
        if let Some(conns) = ws_map.get_mut(user_id) {
            conns.remove(&conn_id);
            if conns.is_empty() {
                ws_map.remove(user_id);
                false
            } else {
                true
            }
        } else {
            false
        }
    };

    // Only mark offline and broadcast when the last connection closes.
    if !still_connected {
        if user_id.starts_with("bot:") {
            // Remove bot from room_members cache
            let mut rm = state.room_members.write().await;
            for members in rm.values_mut() {
                members.retain(|m| m != user_id);
            }
        } else {
            {
                let mut up = state.user_presence.write().await;
                if let Some(p) = up.get_mut(user_id) {
                    p.connected = false;
                    p.last_active = now_secs();
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
                "status": "offline",
                "is_mobile": false
            });
            for rid in user_rooms {
                broadcast_to_room(state, &rid, &event).await;
            }
        }
    }
}
