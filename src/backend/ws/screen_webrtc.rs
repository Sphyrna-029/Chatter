use crate::backend::{
    constants::{SCREEN_AUDIO_RTP_BUFFER_SIZE, SCREEN_RTP_BUFFER_SIZE},
    helpers::{broadcast_to_room, send_to_user},
    state::{AppState, ScreenPublisherState, ScreenSubscriberState},
    webrtc::{
        create_peer_connection, ice_candidate_to_json, parse_ice_candidate,
        rewrite_rtcp_feedback_for_publisher,
    },
};
use rtcp::{
    packet::Packet as RtcpPacket, payload_feedbacks::picture_loss_indication::PictureLossIndication,
};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::{sync::broadcast, task::JoinHandle};
use webrtc::{
    peer_connection::{
        peer_connection_state::RTCPeerConnectionState,
        sdp::session_description::RTCSessionDescription,
    },
    rtp_transceiver::rtp_codec::RTCRtpCodecCapability,
    track::{
        track_local::{track_local_static_rtp::TrackLocalStaticRTP, TrackLocal, TrackLocalWriter},
        track_remote::TrackRemote,
    },
};

pub(crate) fn subscriber_key(viewer_user_id: &str, sharer_user_id: &str) -> String {
    format!("{}|{}", viewer_user_id, sharer_user_id)
}

/// Send the current viewer list to the sharer so they can display viewer count.
pub(crate) async fn send_screen_viewers_update(state: &AppState, sharer_user_id: &str) {
    let viewers: Vec<String> = {
        let subs = state.screen_subscribers.read().await;
        subs.values()
            .filter(|entry| entry.sharer_user_id == sharer_user_id)
            .map(|entry| entry.viewer_user_id.clone())
            .collect()
    };
    let msg = json!({
        "type": "screen_viewers_update",
        "sharer_user_id": sharer_user_id,
        "viewers": viewers,
    });
    send_to_user(state, sharer_user_id, &msg).await;
}

/// Check if user is in any voice channel (channel_id-keyed map).
/// The room_id param is kept for backward compat but we search all channels.
pub(crate) async fn user_in_voice_room(state: &AppState, _room_id: &str, user_id: &str) -> bool {
    let vc = state.voice_channels.read().await;
    vc.values().any(|members| members.contains_key(user_id))
}

pub(crate) async fn user_is_sharing_screen(state: &AppState, _room_id: &str, user_id: &str) -> bool {
    let vc = state.voice_channels.read().await;
    vc.values().any(|members| {
        members.get(user_id).map(|m| m.screen_sharing).unwrap_or(false)
    })
}

pub(crate) async fn set_user_screen_sharing(
    state: &AppState,
    room_id: &str,
    user_id: &str,
    sharing: bool,
) {
    let mut vc = state.voice_channels.write().await;
    if let Some(room_vc) = vc.get_mut(room_id) {
        if let Some(member) = room_vc.get_mut(user_id) {
            member.screen_sharing = sharing;
        }
    }
}

pub(crate) async fn teardown_screen_subscriber_pair(
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
        send_screen_viewers_update(state, sharer_user_id).await;
    }
}

pub(crate) async fn teardown_screen_subscriptions_for_viewer(
    state: &AppState,
    viewer_user_id: &str,
) {
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

    let mut affected_sharers = Vec::new();
    for subscriber in &subscribers {
        if !affected_sharers.contains(&subscriber.sharer_user_id) {
            affected_sharers.push(subscriber.sharer_user_id.clone());
        }
    }

    for subscriber in subscribers {
        subscriber.forward_task.abort();
        if let Some(audio_task) = subscriber.audio_forward_task {
            audio_task.abort();
        }
        let _ = subscriber.peer_connection.close().await;
    }

    for sharer_id in affected_sharers {
        send_screen_viewers_update(state, &sharer_id).await;
    }
}

pub(crate) async fn teardown_screen_subscriptions_for_sharer(
    state: &AppState,
    sharer_user_id: &str,
) {
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

pub(crate) async fn teardown_screen_publisher(
    state: &AppState,
    sharer_user_id: &str,
) -> Option<String> {
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
    send_screen_viewers_update(state, sharer_user_id).await;
    Some(publisher.room_id)
}

pub(crate) async fn handle_screen_webrtc_publish_offer(
    state: Arc<AppState>,
    user_id: &str,
    room_id: &str,
    channel_id: &str,
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
                channel_id: channel_id.to_string(),
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
        let this_pc = peer_connection.clone();
        peer_connection.on_peer_connection_state_change(Box::new(move |pc_state| {
            let state = state_clone.clone();
            let room_id = room_id.clone();
            let user_id = user_id.clone();
            let this_pc = this_pc.clone();
            Box::pin(async move {
                if matches!(
                    pc_state,
                    RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed
                ) {
                    // Guard: if a newer publisher has replaced this one, don't tear it down.
                    {
                        let publishers = state.screen_publishers.read().await;
                        match publishers.get(&user_id) {
                            Some(p) if !Arc::ptr_eq(&p.peer_connection, &this_pc) => return,
                            _ => {}
                        }
                    }
                    if teardown_screen_publisher(&state, &user_id).await.is_some() {
                        set_user_screen_sharing(&state, &room_id, &user_id, false).await;
                        let event = json!({
                            "type": "screen_share_stopped",
                            "room_id": room_id,
                            "user_id": user_id
                        });
                        broadcast_to_room(&state, &room_id, &event).await;
                    }
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

pub(crate) async fn handle_screen_webrtc_publish_candidate(
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

pub(crate) async fn handle_screen_webrtc_subscribe_offer(
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
        let this_pc = peer_connection.clone();
        peer_connection.on_peer_connection_state_change(Box::new(move |pc_state| {
            let state = state_clone.clone();
            let viewer_user_id = viewer_user_id.clone();
            let sharer_user_id = sharer_user_id.clone();
            let this_pc = this_pc.clone();
            Box::pin(async move {
                if matches!(
                    pc_state,
                    RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed
                ) {
                    // Guard: if a newer subscriber has replaced this one, don't tear it down.
                    {
                        let key = subscriber_key(&viewer_user_id, &sharer_user_id);
                        let subs = state.screen_subscribers.read().await;
                        match subs.get(&key) {
                            Some(s) if !Arc::ptr_eq(&s.peer_connection, &this_pc) => return,
                            _ => {}
                        }
                    }
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
        const LAGGED_PACKET_THRESHOLD_FOR_PLI: u64 = 32;
        let pli_cooldown = std::time::Duration::from_secs(2);
        let periodic_pli_interval = std::time::Duration::from_secs(10);
        let mut last_pli_request = std::time::Instant::now() - pli_cooldown;

        loop {
            // Check if periodic PLI is due (safety net for corruption recovery)
            if last_pli_request.elapsed() >= periodic_pli_interval {
                last_pli_request = std::time::Instant::now();
                let _ = publisher_pc_for_pli
                    .write_rtcp(&[Box::new(PictureLossIndication {
                        sender_ssrc: 0,
                        media_ssrc: pli_media_ssrc,
                    })
                        as Box<dyn RtcpPacket + Send + Sync>])
                    .await;
            }

            match rtp_receiver.recv().await {
                Ok(rtp_packet) => {
                    if local_track.write_rtp(&rtp_packet).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    if skipped >= LAGGED_PACKET_THRESHOLD_FOR_PLI
                        && last_pli_request.elapsed() >= pli_cooldown
                    {
                        last_pli_request = std::time::Instant::now();
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
                    }
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
        send_screen_viewers_update(&state, sharer_user_id).await;
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

pub(crate) async fn handle_screen_webrtc_subscribe_candidate(
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

#[cfg(test)]
mod tests {
    use super::{subscriber_key, teardown_screen_subscriber_pair};
    use crate::backend::{
        app::build_state, state::ScreenSubscriberState, webrtc::create_peer_connection,
    };
    use tokio::time::{sleep, Duration};

    #[test]
    fn subscriber_key_is_stable() {
        assert_eq!(subscriber_key("viewer", "sharer"), "viewer|sharer");
        assert_eq!(subscriber_key("viewer", "sharer"), "viewer|sharer");
    }

    #[tokio::test]
    async fn teardown_screen_subscriber_pair_removes_state() {
        let state = build_state();
        let peer_connection = create_peer_connection(&state).await.unwrap();
        let key = subscriber_key("@viewer:localhost", "@sharer:localhost");

        state.screen_subscribers.write().await.insert(
            key.clone(),
            ScreenSubscriberState {
                viewer_user_id: "@viewer:localhost".to_string(),
                sharer_user_id: "@sharer:localhost".to_string(),
                peer_connection,
                forward_task: tokio::spawn(async {
                    sleep(Duration::from_secs(60)).await;
                }),
                audio_forward_task: Some(tokio::spawn(async {
                    sleep(Duration::from_secs(60)).await;
                })),
            },
        );

        teardown_screen_subscriber_pair(&state, "@viewer:localhost", "@sharer:localhost").await;

        let subscribers = state.screen_subscribers.read().await;
        assert!(!subscribers.contains_key(&key));
    }
}
