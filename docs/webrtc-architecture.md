# Chatter WebRTC Architecture — STUN, TURN & ICE

## Overview

Chatter uses an **SFU (Selective Forwarding Unit)** architecture. Each user publishes
one audio (voice) or video (screen share) stream to the server, and the server relays
it to subscribers.

**Voice** relays through a fixed set of *slots*. A listener holds one connection
carrying `VOICE_MAX_ACTIVE_SPEAKERS` (12) receive-only tracks, and the server
decides which speakers occupy them, a few times a second, by reading the RTP
audio-level header extension. The cost of a call is therefore bounded by the
slot count rather than the headcount — the server holds `2N` peer connections
for `N` participants, and sends each listener at most 12 streams whether the
call has 10 people in it or 300. Screen share and webcam still use one
connection per viewer-publisher pair, which is fine at their fan-out.

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

Both ends of a media connection are ICE agents: the browser and the **SFU**. "Direct"
below means the media reaches the SFU without passing through a relay — it never means
browser-to-browser. Every stream terminates on the server, as the overview above
describes; TURN only changes the route a stream takes to get there.

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
          ├────►║ Direct path to SFU║◄───────┤
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

A listener subscribes once, on join, and never renegotiates. Who is audible
changes by websocket message, not by SDP.

```
  Client A (Publisher)          Chatter Server               Client B (Listener)
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
        │                            │  voice_webrtc_subscribe_offer│
        │                            │  (12 recvonly transceivers)  │
        │                            │  ◄────────────────────────── │
        │                            │                              │
        │                            │  Create server-side PC       │
        │                            │  Add 12 slot tracks          │
        │                            │  (TrackLocalStaticRTP)       │
        │                            │  Create answer               │
        │                            │                              │
        │                            │  voice_webrtc_subscribe_answer
        │                            │  ──────────────────────────► │
        │                            │  voice_slot_map (all empty)  │
        │                            │  ──────────────────────────► │
        │                            │                              │
        │                            │  ◄── ICE candidates ──────► │
        │                            │                              │
        │  RTP + audio level ext     │  every 200ms: rank speakers  │
        │  ═══════════════════►      │                              │
        │                            │  voice_slot_map  (A → slot 0)│
        │                            │  voice_speaking  [A]         │
        │                            │  ──────────────────────────► │
        │                            │                              │
        │                            │         RTP into slot 0      │
        │                            │  ═══════════════════════►    │
```

### Slots

- **Ranking** (`src/backend/ws/voice_slots.rs`) puts anyone currently talking
  first, loudest first; then anyone who spoke within `VOICE_SPEAKER_HOLD_MS`
  (2s). The hold window stops two people trading remarks from swapping slots
  several times a second.
- **Stability**: a speaker who stays in the set keeps their slot index, so only
  slots that genuinely change hands are touched.
- **Re-stamping**: a slot keeps one SSRC while the speaker feeding it changes,
  so the server rewrites sequence numbers and timestamps to stay continuous and
  sets the marker bit on a handover. Without this the receiver's jitter buffer
  stalls every time a slot changes hands.
- **Speaking indicators** come from the server (`voice_speaking`), because a
  client can only measure the ~12 people it can hear, and most of a large call
  is outside that.

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
| `client/src/hooks/useWebRTCVoice.ts` | Voice publish, one slot subscription, trickle ICE, retries |
| `client/src/hooks/useWebRTCScreen.ts` | Screen share publish/subscribe |
| `src/backend/webrtc.rs` | Server PC creation, ICE config, RTCP rewriting |
| `src/backend/ws/voice_webrtc.rs` | Voice signaling handlers, publisher RTP + audio levels |
| `src/backend/ws/voice_slots.rs` | Speaker ranking, slot assignment, RTP re-stamping |
| `src/backend/ws/screen_webrtc.rs` | Screen share signaling handlers |
| `src/backend/routes/auth.rs` | `/api/ice-servers` endpoint |
| `src/backend/state.rs` | Publisher/Subscriber state structs |
