use super::state::AppState;
use rtcp::{
    packet::Packet as RtcpPacket,
    payload_feedbacks::{
        full_intra_request::{FirEntry, FullIntraRequest},
        picture_loss_indication::PictureLossIndication,
    },
};
use serde_json::{json, Value};
use std::sync::Arc;
use webrtc::{
    api::{
        interceptor_registry::register_default_interceptors, media_engine::MediaEngine,
        setting_engine::SettingEngine, APIBuilder, API,
    },
    ice_transport::{
        ice_candidate::RTCIceCandidateInit, ice_candidate_type::RTCIceCandidateType,
        ice_credential_type::RTCIceCredentialType, ice_server::RTCIceServer,
    },
    interceptor::registry::Registry,
    peer_connection::{configuration::RTCConfiguration, RTCPeerConnection},
};

pub(crate) fn parse_ice_candidate(value: &Value) -> Option<RTCIceCandidateInit> {
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

pub(crate) fn ice_candidate_to_json(candidate: &RTCIceCandidateInit) -> Value {
    json!({
        "candidate": candidate.candidate,
        "sdpMid": candidate.sdp_mid,
        "sdpMLineIndex": candidate.sdp_mline_index,
        "usernameFragment": candidate.username_fragment
    })
}

pub(crate) fn build_webrtc_api() -> Arc<API> {
    let mut media_engine = MediaEngine::default();
    media_engine
        .register_default_codecs()
        .expect("register_default_codecs failed");

    let mut registry = Registry::new();
    registry = register_default_interceptors(registry, &mut media_engine)
        .expect("register_default_interceptors failed");

    let mut setting_engine = SettingEngine::default();

    // If WEBRTC_IP is set (e.g. the server's public IP), advertise it as a
    // server-reflexive candidate so remote peers can connect through NAT while
    // LAN peers can still connect via the local host candidate.
    if let Ok(ip) = std::env::var("WEBRTC_IP") {
        let ips: Vec<String> = ip.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
        if !ips.is_empty() {
            println!("WebRTC: advertising NAT 1:1 IPs as srflx candidates: {:?}", ips);
            setting_engine.set_nat_1to1_ips(ips, RTCIceCandidateType::Srflx);
        }
    }


    Arc::new(
        APIBuilder::new()
            .with_media_engine(media_engine)
            .with_interceptor_registry(registry)
            .with_setting_engine(setting_engine)
            .build(),
    )
}

fn default_webrtc_config() -> RTCConfiguration {
    let mut ice_servers = vec![RTCIceServer {
        urls: vec!["stun:stun.l.google.com:19302".to_string()],
        ..Default::default()
    }];

    // Add TURN server if configured via environment variables.
    // Example: TURN_URL=turn:your-server.com:3478
    //          TURN_USERNAME=user
    //          TURN_PASSWORD=pass
    if let Ok(turn_url) = std::env::var("TURN_URL") {
        if !turn_url.is_empty() {
            let username = std::env::var("TURN_USERNAME").unwrap_or_default();
            let credential = std::env::var("TURN_PASSWORD").unwrap_or_default();
            ice_servers.push(RTCIceServer {
                urls: turn_url.split(',').map(|s| s.trim().to_string()).collect(),
                username,
                credential,
                credential_type: RTCIceCredentialType::Password,
                ..Default::default()
            });
        }
    }

    RTCConfiguration {
        ice_servers,
        ..Default::default()
    }
}

pub(crate) async fn create_peer_connection(
    state: &AppState,
) -> Result<Arc<RTCPeerConnection>, webrtc::Error> {
    state
        .webrtc_api
        .new_peer_connection(default_webrtc_config())
        .await
        .map(Arc::new)
}

/// Forward only keyframe requests (PLI/FIR) from subscribers to the publisher.
/// NACKs are intentionally NOT forwarded: the server's default interceptors
/// cache recent RTP packets and handle retransmissions on each leg independently.
/// Forwarding subscriber NACKs to the publisher causes NACK amplification —
/// the publisher's browser interprets them as loss on its own upload path and
/// aggressively reduces bitrate/framerate.
pub(crate) fn rewrite_rtcp_feedback_for_publisher(
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

#[cfg(test)]
mod tests {
    use super::{ice_candidate_to_json, parse_ice_candidate, rewrite_rtcp_feedback_for_publisher};
    use rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication;
    use serde_json::json;

    #[test]
    fn ice_candidate_round_trip_preserves_fields() {
        let source = json!({
            "candidate": "candidate:1 1 udp 2113937151 192.168.1.2 9999 typ host",
            "sdpMid": "0",
            "sdpMLineIndex": 0,
            "usernameFragment": "ufrag"
        });

        let parsed = parse_ice_candidate(&source).expect("candidate should parse");
        let json_value = ice_candidate_to_json(&parsed);

        assert_eq!(json_value["candidate"], source["candidate"]);
        assert_eq!(json_value["sdpMid"], source["sdpMid"]);
        assert_eq!(json_value["sdpMLineIndex"], source["sdpMLineIndex"]);
        assert_eq!(json_value["usernameFragment"], source["usernameFragment"]);
    }

    #[test]
    fn rewrite_rtcp_feedback_updates_media_ssrc() {
        let pli = PictureLossIndication {
            sender_ssrc: 42,
            media_ssrc: 7,
        };

        let rewritten = rewrite_rtcp_feedback_for_publisher(&pli, 100).expect("should rewrite");
        let rewritten_pli = rewritten
            .as_any()
            .downcast_ref::<PictureLossIndication>()
            .expect("should stay PLI");

        assert_eq!(rewritten_pli.sender_ssrc, 0);
        assert_eq!(rewritten_pli.media_ssrc, 100);
    }
}
