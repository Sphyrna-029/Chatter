use super::screen_webrtc::user_in_voice_room;
use crate::backend::{
    constants::VOICE_RTP_BUFFER_SIZE,
    helpers::{broadcast_to_voice_channel, channel_permissions, send_to_user},
    metrics::{MediaKind, METRICS},
    state::{AppState, PendingVoiceSubscribe, VoicePublisherState, VoiceSubscriberState},
    webrtc::{create_peer_connection, ice_candidate_to_json, parse_ice_candidate},
};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::broadcast;
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
    util::MarshalSize,
};

pub(crate) fn voice_subscriber_key(listener_user_id: &str, speaker_user_id: &str) -> String {
    format!("voice:{}|{}", listener_user_id, speaker_user_id)
}

pub(crate) async fn teardown_voice_subscriber_pair(
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
        if let Err(e) = subscriber.peer_connection.close().await {
            eprintln!("[voice] teardown_voice_subscriber_pair close error: {e}");
        }
    }
}

pub(crate) async fn teardown_voice_subscriptions_for_listener(
    state: &AppState,
    listener_user_id: &str,
) {
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
        if let Err(e) = subscriber.peer_connection.close().await {
            eprintln!("[voice] teardown_voice_subscriptions_for_listener close error: {e}");
        }
    }
}

pub(crate) async fn teardown_voice_subscriptions_for_speaker(
    state: &AppState,
    speaker_user_id: &str,
) {
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
        if let Err(e) = subscriber.peer_connection.close().await {
            eprintln!("[voice] teardown_voice_subscriptions_for_speaker close error: {e}");
        }
    }
}

pub(crate) async fn teardown_voice_publisher(
    state: &AppState,
    speaker_user_id: &str,
) -> Option<String> {
    let publisher = {
        let mut publishers = state.voice_publishers.write().await;
        publishers.remove(speaker_user_id)
    };

    // Clear any queued subscribe offers waiting on this publisher's track
    state
        .pending_voice_subscribes
        .write()
        .await
        .remove(speaker_user_id);

    let publisher = match publisher {
        Some(p) => p,
        None => return None,
    };

    teardown_voice_subscriptions_for_speaker(state, speaker_user_id).await;
    if let Err(e) = publisher.peer_connection.close().await {
        eprintln!("[voice] teardown_voice_publisher close error for {speaker_user_id}: {e}");
    }
    Some(publisher.room_id)
}

// ---------------------------------------------------------------------------
// Voice WebRTC signaling handlers
// ---------------------------------------------------------------------------

pub(crate) async fn handle_voice_webrtc_publish_offer(
    state: Arc<AppState>,
    user_id: &str,
    room_id: &str,
    channel_id: &str,
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

    // The real enforcement point for a server mute: refuse the audio at the
    // SFU. Disabling the track client-side is a courtesy a patched client can
    // simply skip.
    let force_muted = state
        .voice_force_muted
        .read()
        .await
        .get(room_id)
        .map(|users| users.iter().any(|u| u == user_id))
        .unwrap_or(false);
    if force_muted {
        let error = json!({
            "type": "voice_webrtc_error",
            "scope": "publish",
            "room_id": room_id,
            "detail": "You have been muted by a moderator"
        });
        send_to_user(&state, user_id, &error).await;
        return;
    }

    // Same reasoning for the speak permission: enforce it where the audio
    // actually arrives, not only by hiding the mic button.
    if !channel_permissions(&state, room_id, channel_id, user_id)
        .await
        .speak
    {
        let error = json!({
            "type": "voice_webrtc_error",
            "scope": "publish",
            "room_id": room_id,
            "detail": "You do not have permission to speak in this room"
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
                channel_id: channel_id.to_string(),
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
        let this_pc = peer_connection.clone();
        peer_connection.on_peer_connection_state_change(Box::new(move |pc_state| {
            let state = state_clone.clone();
            let user_id = user_id.clone();
            let this_pc = this_pc.clone();
            Box::pin(async move {
                if matches!(
                    pc_state,
                    RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed
                ) {
                    // Guard: if a newer publisher has replaced this one, don't tear it down.
                    // This prevents a race where the old PC's Closed callback fires after
                    // channel-switch has already stored a new publisher for the same user.
                    {
                        let publishers = state.voice_publishers.read().await;
                        match publishers.get(&user_id) {
                            Some(p) if !Arc::ptr_eq(&p.peer_connection, &this_pc) => return,
                            _ => {}
                        }
                    }
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

                // Notify only the members of the publisher's voice channel that the
                // track is ready. Broadcasting to the whole room would cause users
                // in other voice channels to subscribe, leaking audio across channels.
                let room_channel = {
                    let publishers = state.voice_publishers.read().await;
                    publishers
                        .get(&user_id)
                        .map(|p| (p.room_id.clone(), p.channel_id.clone()))
                };
                if let Some((ref room_id, ref channel_id)) = room_channel {
                    let event = json!({
                        "type": "voice_webrtc_publisher_ready",
                        "room_id": room_id,
                        "channel_id": channel_id,
                        "user_id": user_id
                    });
                    broadcast_to_voice_channel(&state, channel_id, &event).await;
                }

                // Drain any subscribe offers that arrived before the track was ready.
                // These were queued instead of rejected, so subscribers don't have to
                // retry with backoff — they get fulfilled instantly.
                let pending_subs = {
                    let mut pending = state.pending_voice_subscribes.write().await;
                    pending.remove(&user_id).unwrap_or_default()
                };
                if !pending_subs.is_empty() {
                    let room_id = room_channel.as_ref().map(|(r, _)| r.as_str()).unwrap_or("");
                    for sub in pending_subs {
                        handle_voice_webrtc_subscribe_offer(
                            state.clone(),
                            &sub.listener_user_id,
                            room_id,
                            &user_id,
                            &sub.sdp,
                        )
                        .await;
                    }
                }

                // Read RTP from publisher and broadcast
                let rtp_user_id = user_id.clone();
                tokio::spawn(async move {
                    loop {
                        match track.read_rtp().await {
                            Ok((rtp_packet, _)) => {
                                METRICS.record_in(MediaKind::Voice, rtp_packet.marshal_size());
                                let _ = rtp_sender.send(rtp_packet);
                            }
                            Err(e) => {
                                eprintln!(
                                    "[voice] RTP read ended for publisher {rtp_user_id}: {e}"
                                );
                                break;
                            }
                        }
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

pub(crate) async fn handle_voice_webrtc_publish_candidate(
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

pub(crate) async fn handle_voice_webrtc_subscribe_offer(
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

    // Both users must be in the same voice channel. Subscribing across channels
    // would leak audio to users who have already switched away.
    let in_same_channel = {
        let vc = state.voice_channels.read().await;
        vc.values().any(|members| {
            members.contains_key(listener_user_id) && members.contains_key(speaker_user_id)
        })
    };
    if !in_same_channel {
        let error = json!({
            "type": "voice_webrtc_error",
            "scope": "subscribe",
            "room_id": room_id,
            "speaker_user_id": speaker_user_id,
            "detail": "You must be in the same voice channel as the speaker"
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

    let (codec_capability, publisher_rtp_sender) = match (
        publisher_state.audio_codec.clone(),
        publisher_state.rtp_sender.clone(),
    ) {
        (Some(codec), Some(rtp)) => (codec, rtp),
        _ => {
            // Track not ready yet — queue the subscribe and it will be fulfilled
            // automatically when the publisher's on_track fires. No error sent to
            // client, no backoff retry needed.
            let mut pending = state.pending_voice_subscribes.write().await;
            pending
                .entry(speaker_user_id.to_string())
                .or_default()
                .push(PendingVoiceSubscribe {
                    listener_user_id: listener_user_id.to_string(),
                    sdp: sdp.to_string(),
                });
            return;
        }
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
        let this_pc = peer_connection.clone();
        peer_connection.on_peer_connection_state_change(Box::new(move |pc_state| {
            let state = state_clone.clone();
            let listener_user_id = listener_user_id.clone();
            let speaker_user_id = speaker_user_id.clone();
            let this_pc = this_pc.clone();
            Box::pin(async move {
                if matches!(
                    pc_state,
                    RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed
                ) {
                    // Guard: if a newer subscriber has replaced this one, don't tear it down.
                    {
                        let key = voice_subscriber_key(&listener_user_id, &speaker_user_id);
                        let subs = state.voice_subscribers.read().await;
                        match subs.get(&key) {
                            Some(s) if !Arc::ptr_eq(&s.peer_connection, &this_pc) => return,
                            _ => {}
                        }
                    }
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
        if let Err(e) = peer_connection.close().await {
            eprintln!("[voice] subscribe add_track cleanup close error: {e}");
        }
        return;
    }

    // Forward RTP from publisher broadcast channel to subscriber local track
    let mut rtp_receiver = publisher_rtp_sender.subscribe();
    let forward_task = tokio::spawn(async move {
        loop {
            match rtp_receiver.recv().await {
                Ok(rtp_packet) => match local_track.write_rtp(&rtp_packet).await {
                    Ok(bytes) => METRICS.record_out(MediaKind::Voice, bytes),
                    Err(_) => break,
                },
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    METRICS.record_lagged(MediaKind::Voice, skipped);
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

pub(crate) async fn handle_voice_webrtc_subscribe_candidate(
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

#[cfg(test)]
mod tests {
    use super::{teardown_voice_subscriber_pair, voice_subscriber_key};
    use crate::backend::{
        app::build_state, state::VoiceSubscriberState, webrtc::create_peer_connection,
    };
    use tokio::time::{sleep, Duration};

    #[test]
    fn voice_subscriber_key_is_stable() {
        assert_eq!(
            voice_subscriber_key("listener", "speaker"),
            "voice:listener|speaker"
        );
        assert_eq!(
            voice_subscriber_key("listener", "speaker"),
            "voice:listener|speaker"
        );
    }

    #[tokio::test]
    async fn teardown_voice_subscriber_pair_removes_state() {
        let state = build_state().await;
        let peer_connection = create_peer_connection(&state).await.unwrap();
        let key = voice_subscriber_key("@listener:localhost", "@speaker:localhost");

        state.voice_subscribers.write().await.insert(
            key.clone(),
            VoiceSubscriberState {
                listener_user_id: "@listener:localhost".to_string(),
                speaker_user_id: "@speaker:localhost".to_string(),
                peer_connection,
                forward_task: tokio::spawn(async {
                    sleep(Duration::from_secs(60)).await;
                }),
            },
        );

        teardown_voice_subscriber_pair(&state, "@listener:localhost", "@speaker:localhost").await;

        let subscribers = state.voice_subscribers.read().await;
        assert!(!subscribers.contains_key(&key));
    }
}
