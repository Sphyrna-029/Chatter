use super::screen_webrtc::user_in_voice_room;
use super::voice_slots::release_slots_for_speaker;
use crate::backend::{
    constants::{VOICE_ACTIVITY_DBOV_THRESHOLD, VOICE_MAX_ACTIVE_SPEAKERS, VOICE_RTP_BUFFER_SIZE},
    helpers::{channel_permissions, now_millis, send_to_user},
    metrics::{MediaKind, METRICS},
    state::{AppState, VoiceListenerState, VoicePublisherState, VoiceSlot},
    webrtc::{
        create_peer_connection, ice_candidate_to_json, parse_ice_candidate,
        AUDIO_LEVEL_EXTENSION_URI,
    },
};
use rtp::extension::audio_level_extension::AudioLevelExtension;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicU64, AtomicU8, Ordering},
    Arc, Mutex,
};
use tokio::sync::broadcast;
use webrtc::{
    api::media_engine::MIME_TYPE_OPUS,
    peer_connection::{
        peer_connection_state::RTCPeerConnectionState,
        sdp::session_description::RTCSessionDescription,
    },
    rtp_transceiver::{rtp_codec::RTCRtpCodecCapability, rtp_receiver::RTCRtpReceiver},
    track::{
        track_local::{track_local_static_rtp::TrackLocalStaticRTP, TrackLocal},
        track_remote::TrackRemote,
    },
    util::{MarshalSize, Unmarshal},
};

/// Codec for every slot track.
///
/// Slots are built before anyone has necessarily published, and they outlive
/// the speakers that pass through them, so they cannot take their codec from a
/// publisher. Every browser publishes Opus, so pinning it here is what lets a
/// listener subscribe immediately instead of waiting for a speaker to appear.
fn slot_codec() -> RTCRtpCodecCapability {
    RTCRtpCodecCapability {
        mime_type: MIME_TYPE_OPUS.to_string(),
        clock_rate: 48_000,
        channels: 2,
        sdp_fmtp_line: "minptime=10;useinbandfec=1;usedtx=1".to_string(),
        rtcp_feedback: vec![],
    }
}

pub(crate) async fn teardown_voice_listener(state: &AppState, listener_user_id: &str) {
    let listener = {
        let mut listeners = state.voice_listeners.write().await;
        listeners.remove(listener_user_id)
    };

    let Some(listener) = listener else {
        return;
    };

    for slot in &listener.slots {
        if let Ok(mut assignment) = slot.assignment.lock() {
            if let Some(assigned) = assignment.take() {
                assigned.forward_task.abort();
            }
        }
    }
    if let Err(e) = listener.peer_connection.close().await {
        eprintln!("[voice] teardown_voice_listener close error for {listener_user_id}: {e}");
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

    let publisher = publisher?;

    // Stop anyone still hearing them before the connection goes; the next sweep
    // refills the slots they vacated.
    release_slots_for_speaker(state, speaker_user_id).await;
    if let Err(e) = publisher.peer_connection.close().await {
        eprintln!("[voice] teardown_voice_publisher close error for {speaker_user_id}: {e}");
    }
    Some(publisher.room_id)
}

/// Tell a listener which speaker is in which slot. Slot index is the order the
/// tracks were added, which is the order of the m-lines in the answer, so the
/// client can map each one onto the transceiver it already has.
pub(crate) async fn send_slot_map(
    state: &AppState,
    listener_user_id: &str,
    room_id: &str,
    channel_id: &str,
    slots: &[Option<String>],
) {
    let entries: Vec<Value> = slots
        .iter()
        .enumerate()
        .map(|(index, occupant)| json!({ "slot": index, "user_id": occupant }))
        .collect();
    send_to_user(
        state,
        listener_user_id,
        &json!({
            "type": "voice_slot_map",
            "room_id": room_id,
            "channel_id": channel_id,
            "slots": entries,
        }),
    )
    .await;
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

    let audio_level = Arc::new(AtomicU8::new(u8::MAX));
    let last_voice_ms = Arc::new(AtomicU64::new(0));

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
                audio_level: audio_level.clone(),
                last_voice_ms: last_voice_ms.clone(),
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
        peer_connection.on_track(Box::new(
            move |track: Arc<TrackRemote>, receiver: Arc<RTCRtpReceiver>, _| {
                let state = state_clone.clone();
                let user_id = user_id.clone();
                let audio_level = audio_level.clone();
                let last_voice_ms = last_voice_ms.clone();
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

                    // Which header extension id carries the audio level was
                    // settled during negotiation and differs per connection.
                    let audio_level_id = receiver
                        .get_parameters()
                        .await
                        .header_extensions
                        .iter()
                        .find(|ext| ext.uri == AUDIO_LEVEL_EXTENSION_URI)
                        .map(|ext| ext.id as u8);

                    // Nothing is announced here. Listeners do not subscribe to
                    // individual publishers any more, so a track becoming ready
                    // is only the slot sweep's business — and telling the whole
                    // channel about it would be an O(N) broadcast per join that
                    // nobody acts on.

                    // Read RTP from publisher, note how loud it was, and broadcast
                    let rtp_user_id = user_id.clone();
                    tokio::spawn(async move {
                        loop {
                            match track.read_rtp().await {
                                Ok((rtp_packet, _)) => {
                                    METRICS.record_in(MediaKind::Voice, rtp_packet.marshal_size());
                                    if let Some(id) = audio_level_id {
                                        record_audio_level(
                                            &rtp_packet,
                                            id,
                                            &audio_level,
                                            &last_voice_ms,
                                        );
                                    }
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
                        // Silence the publisher's activity so a stream that has
                        // stopped cannot go on holding a slot.
                        audio_level.store(u8::MAX, Ordering::Relaxed);
                    });
                })
            },
        ));
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

/// Note how loud a packet was, so the sweep can rank speakers without decoding
/// anything. The level is -dBov: 0 is loudest, 127 is silence.
fn record_audio_level(
    packet: &rtp::packet::Packet,
    extension_id: u8,
    audio_level: &AtomicU8,
    last_voice_ms: &AtomicU64,
) {
    let Some(mut payload) = packet.header.get_extension(extension_id) else {
        return;
    };
    let Ok(extension) = AudioLevelExtension::unmarshal(&mut payload) else {
        return;
    };
    audio_level.store(extension.level, Ordering::Relaxed);
    if extension.level <= VOICE_ACTIVITY_DBOV_THRESHOLD {
        last_voice_ms.store(now_millis().max(0) as u64, Ordering::Relaxed);
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

/// Set up a listener's one subscription to the call.
///
/// The client offers a fixed number of receive-only transceivers and gets back
/// that many slot tracks, all silent to begin with. Who occupies them is
/// decided by the periodic sweep and announced over the websocket, so nobody
/// joining or leaving the call requires renegotiating this connection.
pub(crate) async fn handle_voice_webrtc_subscribe_offer(
    state: Arc<AppState>,
    listener_user_id: &str,
    room_id: &str,
    sdp: &str,
) {
    if room_id.is_empty() || sdp.is_empty() {
        let error = json!({
            "type": "voice_webrtc_error",
            "scope": "subscribe",
            "room_id": room_id,
            "detail": "Missing room_id or sdp"
        });
        send_to_user(&state, listener_user_id, &error).await;
        return;
    }

    let channel_id = {
        let voice_channels = state.voice_channels.read().await;
        voice_channels
            .iter()
            .find(|(_, members)| members.contains_key(listener_user_id))
            .map(|(channel_id, _)| channel_id.clone())
    };
    let Some(channel_id) = channel_id else {
        let error = json!({
            "type": "voice_webrtc_error",
            "scope": "subscribe",
            "room_id": room_id,
            "detail": "You must be in a voice channel before subscribing"
        });
        send_to_user(&state, listener_user_id, &error).await;
        return;
    };

    teardown_voice_listener(&state, listener_user_id).await;

    let peer_connection = match create_peer_connection(&state).await {
        Ok(pc) => pc,
        Err(err) => {
            let error = json!({
                "type": "voice_webrtc_error",
                "scope": "subscribe",
                "room_id": room_id,
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
        peer_connection.on_ice_candidate(Box::new(move |candidate| {
            let state = state_clone.clone();
            let room_id = room_id.clone();
            let listener_user_id = listener_user_id.clone();
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
        let this_pc = peer_connection.clone();
        peer_connection.on_peer_connection_state_change(Box::new(move |pc_state| {
            let state = state_clone.clone();
            let listener_user_id = listener_user_id.clone();
            let this_pc = this_pc.clone();
            Box::pin(async move {
                if matches!(
                    pc_state,
                    RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed
                ) {
                    // Guard: if a newer subscription has replaced this one, don't tear it down.
                    {
                        let listeners = state.voice_listeners.read().await;
                        match listeners.get(&listener_user_id) {
                            Some(l) if !Arc::ptr_eq(&l.peer_connection, &this_pc) => return,
                            _ => {}
                        }
                    }
                    teardown_voice_listener(&state, &listener_user_id).await;
                }
            })
        }));
    }

    let offer = match RTCSessionDescription::offer(sdp.to_string()) {
        Ok(offer) => offer,
        Err(err) => {
            let error = json!({
                "type": "voice_webrtc_error",
                "scope": "subscribe",
                "room_id": room_id,
                "detail": format!("Invalid offer SDP: {}", err)
            });
            send_to_user(&state, listener_user_id, &error).await;
            if let Err(e) = peer_connection.close().await {
                eprintln!("[voice] subscribe offer cleanup close error: {e}");
            }
            return;
        }
    };

    let mut slots = Vec::with_capacity(VOICE_MAX_ACTIVE_SPEAKERS);
    for index in 0..VOICE_MAX_ACTIVE_SPEAKERS {
        let track = Arc::new(TrackLocalStaticRTP::new(
            slot_codec(),
            format!("voice-slot-{index}"),
            format!("chatter-sfu-{listener_user_id}"),
        ));
        let track_for_sender: Arc<dyn TrackLocal + Send + Sync> = track.clone();
        if let Err(err) = peer_connection.add_track(track_for_sender).await {
            let error = json!({
                "type": "voice_webrtc_error",
                "scope": "subscribe",
                "room_id": room_id,
                "detail": format!("Failed adding slot track: {}", err)
            });
            send_to_user(&state, listener_user_id, &error).await;
            if let Err(e) = peer_connection.close().await {
                eprintln!("[voice] subscribe add_track cleanup close error: {e}");
            }
            return;
        }
        slots.push(Arc::new(VoiceSlot {
            track,
            assignment: Mutex::new(None),
            restamp: Mutex::new(Default::default()),
        }));
    }

    // Only now the offer. add_track reuses an existing transceiver only when
    // the track id matches its sender's, which it never will here — so adding
    // the slot tracks after the remote description would build a second set of
    // transceivers, and the slot indices the client maps by would not line up.
    if let Err(err) = peer_connection.set_remote_description(offer).await {
        let error = json!({
            "type": "voice_webrtc_error",
            "scope": "subscribe",
            "room_id": room_id,
            "detail": format!("Failed setting remote description: {}", err)
        });
        send_to_user(&state, listener_user_id, &error).await;
        if let Err(e) = peer_connection.close().await {
            eprintln!("[voice] subscribe remote description cleanup close error: {e}");
        }
        return;
    }

    let answer = match peer_connection.create_answer(None).await {
        Ok(answer) => answer,
        Err(err) => {
            let error = json!({
                "type": "voice_webrtc_error",
                "scope": "subscribe",
                "room_id": room_id,
                "detail": format!("Failed creating answer: {}", err)
            });
            send_to_user(&state, listener_user_id, &error).await;
            if let Err(e) = peer_connection.close().await {
                eprintln!("[voice] subscribe create_answer cleanup close error: {e}");
            }
            return;
        }
    };

    if let Err(err) = peer_connection.set_local_description(answer).await {
        let error = json!({
            "type": "voice_webrtc_error",
            "scope": "subscribe",
            "room_id": room_id,
            "detail": format!("Failed setting local description: {}", err)
        });
        send_to_user(&state, listener_user_id, &error).await;
        if let Err(e) = peer_connection.close().await {
            eprintln!("[voice] subscribe local description cleanup close error: {e}");
        }
        return;
    }

    let Some(local_desc) = peer_connection.local_description().await else {
        let error = json!({
            "type": "voice_webrtc_error",
            "scope": "subscribe",
            "room_id": room_id,
            "detail": "Missing local description for voice subscriber"
        });
        send_to_user(&state, listener_user_id, &error).await;
        if let Err(e) = peer_connection.close().await {
            eprintln!("[voice] subscribe missing description cleanup close error: {e}");
        }
        return;
    };

    let slot_count = slots.len();
    {
        let mut listeners = state.voice_listeners.write().await;
        listeners.insert(
            listener_user_id.to_string(),
            VoiceListenerState {
                room_id: room_id.to_string(),
                channel_id: channel_id.clone(),
                peer_connection,
                slots,
                last_sent_map: Mutex::new(vec![None; slot_count]),
            },
        );
    }

    send_to_user(
        &state,
        listener_user_id,
        &json!({
            "type": "voice_webrtc_subscribe_answer",
            "room_id": room_id,
            "channel_id": channel_id,
            "slot_count": slot_count,
            "sdp": local_desc.sdp
        }),
    )
    .await;

    // Slots start empty; the sweep fills them within a tick.
    send_slot_map(
        &state,
        listener_user_id,
        room_id,
        &channel_id,
        &vec![None; slot_count],
    )
    .await;
}

pub(crate) async fn handle_voice_webrtc_subscribe_candidate(
    state: &AppState,
    listener_user_id: &str,
    candidate_value: &Value,
) {
    let peer_connection = {
        let listeners = state.voice_listeners.read().await;
        listeners
            .get(listener_user_id)
            .map(|listener| listener.peer_connection.clone())
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
            "detail": format!("Failed adding ICE candidate: {}", err)
        });
        send_to_user(state, listener_user_id, &error).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::app::build_state;
    use crate::backend::state::VoiceMemberState;
    use std::collections::HashMap;
    use webrtc::api::media_engine::MediaEngine;
    use webrtc::api::APIBuilder;
    use webrtc::peer_connection::configuration::RTCConfiguration;
    use webrtc::rtp_transceiver::rtp_codec::RTPCodecType;

    async fn in_voice(state: &AppState, channel_id: &str, room_id: &str, user_id: &str) {
        let mut voice_channels = state.voice_channels.write().await;
        voice_channels
            .entry(channel_id.to_string())
            .or_insert_with(HashMap::new)
            .insert(
                user_id.to_string(),
                VoiceMemberState {
                    muted: false,
                    deafened: false,
                    screen_sharing: false,
                    force_muted: false,
                    clipping: false,
                    room_id: room_id.to_string(),
                    conn_id: 1,
                },
            );
    }

    /// The design rests on one assumption about webrtc-rs: that adding N tracks
    /// to a connection whose remote offer carried N receive-only transceivers
    /// binds them in order, giving an answer with N m-lines the client can map
    /// onto slot indices. Pinned here without a database so it runs anywhere.
    #[tokio::test]
    async fn slot_tracks_bind_to_the_transceivers_the_client_offered() {
        let build_api = || {
            let mut media_engine = MediaEngine::default();
            media_engine.register_default_codecs().unwrap();
            APIBuilder::new().with_media_engine(media_engine).build()
        };

        let client = build_api()
            .new_peer_connection(RTCConfiguration::default())
            .await
            .unwrap();
        for _ in 0..VOICE_MAX_ACTIVE_SPEAKERS {
            client
                .add_transceiver_from_kind(RTPCodecType::Audio, None)
                .await
                .unwrap();
        }
        let offer = client.create_offer(None).await.unwrap();
        client.set_local_description(offer.clone()).await.unwrap();

        let server = build_api()
            .new_peer_connection(RTCConfiguration::default())
            .await
            .unwrap();
        for index in 0..VOICE_MAX_ACTIVE_SPEAKERS {
            let track: Arc<dyn TrackLocal + Send + Sync> = Arc::new(TrackLocalStaticRTP::new(
                slot_codec(),
                format!("voice-slot-{index}"),
                "chatter-sfu-test".to_string(),
            ));
            server.add_track(track).await.unwrap();
        }
        server.set_remote_description(offer).await.unwrap();
        let answer = server.create_answer(None).await.unwrap();

        assert_eq!(
            answer.sdp.matches("m=audio").count(),
            VOICE_MAX_ACTIVE_SPEAKERS,
            "each slot needs its own m-line, in order, for slot indices to line up"
        );
        assert_eq!(
            server.get_senders().await.len(),
            VOICE_MAX_ACTIVE_SPEAKERS,
            "every slot track must have bound to a transceiver"
        );
        // The client must see one receiving transceiver per slot, in the order
        // it offered them — that ordering is what maps a track to a slot index.
        assert_eq!(
            client.get_transceivers().await.len(),
            VOICE_MAX_ACTIVE_SPEAKERS
        );
    }

    /// A listener's subscription is one connection carrying every slot,
    /// regardless of who is in the call — that is the whole point of the
    /// design, so it is worth pinning against a real negotiation.
    #[tokio::test]
    async fn subscribe_answers_with_one_track_per_slot() {
        let state = build_state().await;
        in_voice(&state, "!chan:localhost", "!room:localhost", "@l:localhost").await;

        // Stand in for the browser: offer the slot count as recvonly.
        let mut media_engine = MediaEngine::default();
        media_engine.register_default_codecs().unwrap();
        let api = APIBuilder::new().with_media_engine(media_engine).build();
        let client = api
            .new_peer_connection(RTCConfiguration::default())
            .await
            .unwrap();
        for _ in 0..VOICE_MAX_ACTIVE_SPEAKERS {
            client
                .add_transceiver_from_kind(
                    webrtc::rtp_transceiver::rtp_codec::RTPCodecType::Audio,
                    None,
                )
                .await
                .unwrap();
        }
        let offer = client.create_offer(None).await.unwrap();
        client.set_local_description(offer.clone()).await.unwrap();

        handle_voice_webrtc_subscribe_offer(
            state.clone(),
            "@l:localhost",
            "!room:localhost",
            &offer.sdp,
        )
        .await;

        let listeners = state.voice_listeners.read().await;
        let listener = listeners
            .get("@l:localhost")
            .expect("subscription should be stored");
        assert_eq!(listener.slots.len(), VOICE_MAX_ACTIVE_SPEAKERS);
        assert_eq!(listener.channel_id, "!chan:localhost");
        let answer = listener
            .peer_connection
            .local_description()
            .await
            .expect("an answer should have been produced");
        assert_eq!(
            answer.sdp.matches("m=audio").count(),
            VOICE_MAX_ACTIVE_SPEAKERS,
            "every slot needs its own m-line for the client to map onto"
        );
    }

    #[tokio::test]
    async fn subscribe_is_refused_outside_a_voice_channel() {
        let state = build_state().await;
        handle_voice_webrtc_subscribe_offer(
            state.clone(),
            "@nobody:localhost",
            "!room:localhost",
            "v=0\r\n",
        )
        .await;
        assert!(state.voice_listeners.read().await.is_empty());
    }

    #[tokio::test]
    async fn teardown_voice_listener_removes_state() {
        let state = build_state().await;
        let peer_connection = create_peer_connection(&state).await.unwrap();
        state.voice_listeners.write().await.insert(
            "@l:localhost".to_string(),
            VoiceListenerState {
                room_id: "!room:localhost".to_string(),
                channel_id: "!chan:localhost".to_string(),
                peer_connection,
                slots: vec![],
                last_sent_map: Mutex::new(vec![]),
            },
        );

        teardown_voice_listener(&state, "@l:localhost").await;

        assert!(!state
            .voice_listeners
            .read()
            .await
            .contains_key("@l:localhost"));
    }
}
