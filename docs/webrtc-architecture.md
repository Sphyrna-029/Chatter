# Chatter WebRTC Architecture — STUN, TURN & ICE

## Overview

Chatter uses an **SFU (Selective Forwarding Unit)** architecture. Each user publishes
one audio (voice) or video (screen share) stream to the server, and the server relays
it to every subscriber via individual peer connections.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         CHATTER SERVER (SFU)                            │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                    WebSocket Handler                             │    │
│  │  Receives: offers, answers, ICE candidates, join/leave signals  │    │
│  │  Sends:    answers, ICE candidates, publisher_ready events      │    │
│  └────────────┬────────────────────────────┬───────────────────────┘    │
│               │                            │                            │
│  ┌────────────▼──────────┐   ┌─────────────▼──────────────┐            │
│  │  Publisher Handler     │   │  Subscriber Handler         │           │
│  │                        │   │                             │           │
│  │  • Receives SDP offer  │   │  • Receives SDP offer       │           │
│  │  • Creates server PC   │   │  • Creates server PC        │           │
│  │  • Sends SDP answer    │   │  • Attaches relay track     │           │
│  │  • Extracts audio/     │   │  • Sends SDP answer         │           │
│  │    video track         │   │  • Forwards RTP via         │           │
│  │  • Reads RTP packets   │   │    broadcast channel        │           │
│  │  • Broadcasts to       │   │                             │           │
│  │    tokio channel       │   │                             │           │
│  └────────────┬───────────┘   └──────────────▲──────────────┘           │
│               │                              │                          │
│               │    ┌──────────────────┐      │                          │
│               └───►│ broadcast::channel├──────┘                          │
│                    │ (RTP packets)    │  One channel per publisher       │
│                    └──────────────────┘  N subscribers read from it      │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

## ICE Server Discovery

```
┌──────────┐         GET /api/ice-servers          ┌──────────────┐
│  Browser  │ ──────────────────────────────────►  │ Chatter API   │
│  Client   │                                      │               │
│           │  ◄──────────────────────────────────  │  Reads env:   │
│           │   { "iceServers": [                   │  TURN_URL     │
│           │       { "urls": ["stun:..."] },       │  TURN_PUBLIC  │
│           │       { "urls": ["turn:..."],         │  TURN_USER    │
│           │         "username": "...",             │  TURN_PASS    │
│           │         "credential": "..." }         │               │
│           │     ] }                               │               │
└──────────┘                                       └──────────────┘
     │
     │  Cached in module-level variable (_cachedConfig)
     │  Re-fetched on connection failure before retry
     │  Fallback: stun:stun.l.google.com:19302
```

## ICE Connectivity Flow

```
                     ┌──────────────┐
                     │  STUN Server  │
                     │ (Google or    │
                     │  self-hosted) │
                     └──────┬───────┘
                            │
            ┌───────────────┼───────────────┐
            │  1. Who am I? │               │
            │  (Binding     │  2. You are   │
            │   Request)    │  203.0.113.5  │
            │               │  :54321       │
            ▼               │               ▼
    ┌──────────┐            │        ┌──────────────┐
    │  Browser  │           │        │ Chatter SFU   │
    │  Client   │           │        │ Server        │
    │           │           │        │               │
    │  Gathers: │           │        │  Gathers:     │
    │  • host   │           │        │  • host       │
    │  • srflx  │◄──────────┘        │  • srflx*     │
    │  • relay  │                    │               │
    └─────┬────┘                     └───────┬───────┘
          │                                  │
          │  ICE candidates exchanged via    │
          │  WebSocket (trickle ICE)         │
          │◄────────────────────────────────►│
          │                                  │
          │  STUN binding checks on each     │
          │  candidate pair until one works   │
          │                                  │
          │     ╔═══════════════════╗        │
          ├────►║  Direct P2P path  ║◄───────┤
          │     ║  (host or srflx)  ║        │
          │     ╚═══════════════════╝        │
          │              OR                  │
          │     ╔═══════════════════╗        │
          ├────►║  TURN relay path  ║◄───────┤
          │     ║  (if NAT blocks   ║        │
          │     ║   direct traffic) ║        │
          │     ╚═══════════════════╝        │
          │              │                   │
          │     ┌────────▼────────┐          │
          │     │   TURN Server    │          │
          │     │   (coturn)       │          │
          │     │   Ports:         │          │
          │     │   3478 signaling │          │
          │     │   49152-49252    │          │
          │     │   media relay    │          │
          │     └──────────────────┘          │
          │                                   │
          * WEBRTC_IP env var adds srflx      │
            candidates for NAT 1:1 mapping    │

```

## Voice Call Signaling Sequence

```
  Client A (Publisher)          Chatter Server               Client B (Subscriber)
        │                            │                              │
        │  voice_join                │                              │
        │  ─────────────────────►    │                              │
        │                            │                              │
        │  getUserMedia (mic)        │                              │
        │  Create RTCPeerConnection  │                              │
        │  Add audio track           │                              │
        │                            │                              │
        │  voice_webrtc_publish_offer│                              │
        │  (SDP offer)               │                              │
        │  ─────────────────────►    │                              │
        │                            │  Create server-side PC       │
        │                            │  Set remote description      │
        │                            │  Create answer               │
        │  voice_webrtc_publish_answer                              │
        │  (SDP answer)              │                              │
        │  ◄─────────────────────    │                              │
        │                            │                              │
        │  ◄─── ICE candidates ───►  │  (trickle ICE, both dirs)   │
        │                            │                              │
        │  ═══ DTLS + SRTP ════════  │  (media flows)              │
        │                            │                              │
        │                            │  voice_webrtc_publisher_ready│
        │                            │  ──────────────────────────► │
        │                            │                              │
        │                            │  voice_webrtc_subscribe_offer│
        │                            │  ◄────────────────────────── │
        │                            │                              │
        │                            │  Create server-side PC       │
        │                            │  Attach relay track          │
        │                            │  (TrackLocalStaticRTP)       │
        │                            │  Create answer               │
        │                            │                              │
        │                            │  voice_webrtc_subscribe_answer
        │                            │  ──────────────────────────► │
        │                            │                              │
        │                            │  ◄── ICE candidates ──────► │
        │                            │                              │
        │    RTP packets             │         RTP packets          │
        │  ═══════════════════►      │  ═══════════════════════►    │
        │                            │                              │
        │  Publisher reads RTP       │  Subscriber receives via     │
        │  from track, broadcasts    │  relay track connected to    │
        │  to tokio channel          │  broadcast::channel          │
```

## Media Relay Detail (SFU)

```
    Publisher A                    Server                    Subscribers
   ┌──────────┐            ┌──────────────────┐
   │ Audio    │   SRTP     │  on_track()       │
   │ Track ───┼───────────►│  ┌──────────────┐ │
   └──────────┘            │  │ RTP Read Loop │ │
                           │  │  track.read() │ │
                           │  └──────┬───────┘ │
                           │         │          │        ┌──────────┐
                           │         ▼          │  SRTP  │ Client B  │
                           │  ┌──────────────┐  ├───────►│ Audio Out │
                           │  │  broadcast::  │  │       └──────────┘
                           │  │  channel      │  │
                           │  │              ─┼──┤       ┌──────────┐
                           │  │  (RTP packet  │  │  SRTP │ Client C  │
                           │  │   fan-out)   ─┼──┼──────►│ Audio Out │
                           │  │              ─┼──┤       └──────────┘
                           │  │               │  │
                           │  └───────────────┘  │       ┌──────────┐
                           │                     │  SRTP │ Client D  │
                           │  Each subscriber    ├──────►│ Audio Out │
                           │  has its own PC +   │       └──────────┘
                           │  relay track        │
                           └─────────────────────┘

   RTCP Feedback (subscriber → server → publisher):
   ✓ PLI  (Picture Loss Indication)  — forwarded
   ✓ FIR  (Full Intra Request)       — forwarded
   ✗ NACK (retransmit request)       — dropped (prevents amplification)
```

## Connection Retry & Recovery

```
                        Connection Attempt
                              │
                    ┌─────────▼──────────┐
                    │   Create PC with    │
                    │   cached ICE config │
                    └─────────┬──────────┘
                              │
                    ┌─────────▼──────────┐
                    │   Send SDP Offer    │
                    └─────────┬──────────┘
                              │
              ┌───────────────┼───────────────────┐
              │               │                   │
     ┌────────▼───────┐  ┌───▼──────────┐  ┌─────▼──────────┐
     │ Answer received │  │ 10s timeout  │  │ PC state =     │
     │ PC connected ✓  │  │ (no answer)  │  │ "failed"       │
     └─────────────────┘  └───┬──────────┘  └─────┬──────────┘
                              │                    │
                    ┌─────────▼────────────────────▼──┐
                    │  Tear down PC                    │
                    │  fetchIceServers() (re-fetch)    │
                    │  Exponential backoff wait        │
                    │                                  │
                    │  Publisher: 300ms → 5s max        │
                    │  Subscriber: 1500ms → max         │
                    │  Max retries: 5 (pub) / 8 (sub)  │
                    └─────────────┬────────────────────┘
                                  │
                        ┌─────────▼──────────┐
                        │ Retry from scratch  │
                        │ (new PC, new offer) │
                        └─────────────────────┘

  Additional stuck-state timeouts (subscribers only):
  • "new" for 2.5s   → tear down and retry
  • "connecting" 10s  → tear down and retry
```

## Environment Configuration

```
┌─────────────────────────────────────────────────────────────┐
│                    docker-compose.yml                         │
│                                                              │
│  chatter-server:                                             │
│    TURN_URL=turn:coturn:3478          (server → TURN)        │
│    TURN_PUBLIC_URL=turn:domain:3478   (client → TURN)        │
│    TURN_USERNAME=chatter              (static credential)    │
│    TURN_PASSWORD=changeme             (static credential)    │
│    WEBRTC_IP=<public-ip>              (NAT 1:1 mapping)      │
│                                                              │
│  coturn:                                                     │
│    Ports: 3478/tcp+udp, 49152-49252/udp                      │
│    Config: turnserver.conf                                   │
│                                                              │
│  Candidate priority: host > srflx > relay (TURN)             │
│  TURN is the fallback when symmetric NAT blocks direct path  │
└─────────────────────────────────────────────────────────────┘
```

## Key Files

| File | Purpose |
|------|---------|
| `client/src/lib/webrtc.ts` | ICE server fetch, config cache, retry constants |
| `client/src/hooks/useWebRTCVoice.ts` | Voice publish/subscribe, trickle ICE, retries |
| `client/src/hooks/useWebRTCScreen.ts` | Screen share publish/subscribe |
| `src/backend/webrtc.rs` | Server PC creation, ICE config, RTCP rewriting |
| `src/backend/ws/voice_webrtc.rs` | Voice signaling handlers, RTP relay |
| `src/backend/ws/screen_webrtc.rs` | Screen share signaling handlers |
| `src/backend/routes/auth.rs` | `/api/ice-servers` endpoint |
| `src/backend/state.rs` | Publisher/Subscriber state structs |
