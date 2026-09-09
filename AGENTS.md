# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) or Codex when working with code in this repository.

## What This Is

Chatter is a project intended to replicate discord functionality - lightweight self-hosted chat application built with a Rust backend (`src/main.rs`) and a React + vite frontend (`client/`). It implements a subset of the Matrix Client-Server API with in-memory storage (no database).

## Rules

Please focus on building out one feature/request at a time and validating new features.Focus on simple functionality as if building an MVP ensuring the core features work well.

## Commands

```bash
# Build the server
cargo build

# Run the server (serves both API and client at http://localhost:8000)
cargo run

# Build the React frontend (required before cargo run for production)
cd client && npm install && npm run build

# Dev mode: run Vite dev server with API proxy (hot reload)
cd client && npm run dev
# Then the dev client is at http://localhost:5173

# Build optimized release
cargo build --release

# Run with Docker
docker build -t chatter . && docker run -p 8000:8000 chatter
```
## Rust Workflow 

This repository has a strict Rust workflow so contributors without Rust experience can still ship safe changes.

- Toolchain is pinned in `rust-toolchain.toml` (`1.88.0` with `clippy` and `rustfmt`).
- MSRV is declared in `Cargo.toml` via `rust-version = "1.88"`.
- Rust analyzer defaults are in `.vscode/settings.json` (`clippy` on save + format on save).

Run the main quality gate locally:

```bash
./scripts/rust-ci.sh
```

Run Rust security checks locally:

```bash
cargo install cargo-deny --locked
cargo install cargo-audit --locked
./scripts/rust-security.sh
```

On GitHub, the same checks run in `.github/workflows/rust-quality.yml`.

## Architecture

**src/main.rs** - Axum application serving the REST API and the built React frontend from `client/dist/`. Key aspects:
- Matrix-compatible endpoints under `/_matrix/client/r0/` for auth, rooms, messages, reactions
- Custom convenience endpoints under `/api/` for room listing, voice status, and presence
- Single WebSocket endpoint (`/ws`) handles real-time text events, voice audio streaming, and screen sharing via WebRTC signaling
- All state is in-memory using `Arc<AppState>` with per-field `tokio::sync::RwLock` — everything resets on restart
- Auth uses Bearer tokens generated at register/login, validated manually in each endpoint
- Static files served from `client/dist/` via `tower-http::services::ServeDir`

**client/** - React + Vite + TypeScript frontend using shadcn/ui component library (new-york style with Lyra preset theme, JetBrains Mono font, neutral base color, dark mode). Key files:

*State management (`src/lib/store/`)*:
- `store/types.ts` - `AppState`, `Action` union, `initialState`, `screenStreamsMap`, `AppContextValue`
- `store/reducer.ts` - Pure reducer function (33 switch cases)
- `store/wsHandler.ts` - `createWsMessageHandler` factory for WebSocket message dispatch
- `store/provider.tsx` - `AppProvider`, `useAppContext` hook, all action callbacks, side effects
- `store/index.ts` - Barrel re-exports (`useAppContext`, `AppProvider`, `screenStreamsMap`)

*Theming (`src/lib/theme/`)*:
- `theme/themes.ts` - Built-in list, colour derivation, contrast checks, storage rules
- `theme/display.ts` - Text size, radius, density, motion — applied to `<html>`
- `theme/share.ts` - `ct1_` share codes and links
- `theme/provider.tsx` / `theme/context.ts` - `ThemeProvider`, `useThemeSettings`
- `src/components/AppearanceDialog.tsx` - Theme picker, editor, display settings
- `src/components/ThemeSync.tsx` / `ThemeInvite.tsx` - Cross-device sync; offers from a link or a room

*Shared utilities*:
- `src/lib/api.ts` - HTTP API wrapper functions
- `src/lib/webrtc.ts` - `WEBRTC_CONFIG`, `PeerStats` interface, `canSignal()`, `mungeScreenAudioSdp()`

*Custom hooks (`src/hooks/`)*:
- `useWebRTCVoice.ts` - Voice pub/sub, join/leave/mute/PTT, voice WS signaling, retry logic
- `useWebRTCScreen.ts` - Screen pub/sub, start/stop/watch, screen WS signaling, frozen detection
- `useConnectionStats.ts` - Stats polling from all peer connections
- `useSpeakingDetection.ts` - AudioContext + AnalyserNode + rAF loop for speaking indicators

*Components*:
- `src/components/LoginScreen.tsx` - Auth (login/register)
- `src/components/ChatLayout.tsx` - Main app shell with sidebar layout
- `src/components/AppSidebar.tsx` - Room list, user info, actions (uses shadcn Sidebar)
- `src/components/ChatArea.tsx` - Messages list, input, emoji picker, @mention autocomplete
- `src/components/MessageItem.tsx` - Individual message with reactions
- `src/components/MembersPanel.tsx` - Room members with presence indicators
- `src/components/VoiceControls.tsx` - Voice orchestrator composing hooks and sub-components
- `src/components/voice/VoiceToolbar.tsx` - Join/leave/mute/PTT/screen share buttons
- `src/components/voice/VoiceDebugPanel.tsx` - Debug stats overlay
- `src/components/voice/VoiceMemberList.tsx` - Voice member cards with volume sliders
- `src/components/RoomDialogs.tsx` - Create/Join room dialogs
- Vite dev server proxies API calls to `localhost:8000` for hot-reload development

## API Patterns

- Auth endpoints: POST `/_matrix/client/r0/register`, `/login`, `/logout`
- Room CRUD: POST `/createRoom`, `/{room_id}/join`, `/{room_id}/leave`; GET `/joined_rooms`
- Messages: PUT `/{room_id}/send/m.room.message/{txn_id}`; DELETE via `/{room_id}/redact/{event_id}/{txn_id}`
- Reactions: PUT `/{room_id}/send/m.reaction/{event_id}` (toggles on/off)
- Pins: GET `/api/rooms/{room_id}/pins?channel_id=`; POST/DELETE `/api/rooms/{room_id}/pins/{event_id}` (owner/moderator, a `manage_messages` role, or any DM member)
- Paged listings (pins, search, threads) take `limit`/`offset` and answer with `{ items, has_more, next_offset }`; page with `next_offset`, not the row count
- Messages are the exception: they page by **keyset**, not offset. `before_ts`+`before_event_id` scroll back, `after_ts`+`after_event_id` close a gap, `around_ts` centres on an anchor; all fetch `limit + 1` so `has_more` needs no count. The cursor is the *pair* because `origin_server_ts` is milliseconds and collides — a timestamp-only cursor skips or repeats messages sharing one. Combine a cursor with the visibility filter through `and_filter`, never by merging keys: the base filter has its own `$or` for channel access and a second one would replace it
- Anything user-supplied that reaches a `$regex` goes through `helpers::regex_escape` first — unescaped it both mismatches (`a.b` matching `axb`) and lets a crafted pattern backtrack over a whole room
- Role hierarchy: **lower `position` = higher authority** (owner, then moderator, then custom roles top-down). `role_authority()` ranks a user, `outranks_role()` gates editing/deleting/assigning, and `ungrantable_permission()` stops anyone handing out a permission they do not hold
- Channel overwrites: `channel_permissions()` layers the category's `overwrites` then the channel's over the room set — everyone, then the union of the member's roles, then the member; denies before allows in each step. Owners and moderators bypass them. Legacy `view_roles`/`write_roles` are folded into overwrites by a one-time startup migration (`overwrites_migrated`)
- Permissions: every access check goes through `effective_permissions()` in `helpers.rs`. Owner holds all, moderator holds a fixed legacy set, both keep what their custom roles add; a member with no custom roles gets `RolePermissions::default()`, and once they hold roles the union of those roles is authoritative. `GET /api/rooms/{room_id}/permissions` returns the caller's own set — the client mirrors it only to hide controls
- Pin changes broadcast `m.room.pinned` / `m.room.unpinned` to the room
- Notifications have two halves that never overlap. A **connected** client raises its own from the WebSocket event (`lib/notifications.ts`); a member with **no** socket is reached by Web Push (`backend/push.rs`), which is why `deliver_message` skips anyone in `active_websockets`. The level rules are ported into `backend/push.rs` from `lib/notifications.ts` — change both together. The wire protocol (RFC 8188/8291/8292) is in `backend/webpush.rs`, verified against the RFC 8291 test vector; it is hand-rolled because the `web-push` crate pulls OpenSSL through `ece`
- Push covers every path that broadcasts `m.room.message` — `send_message` and `execute_webhook`. Thread replies broadcast `m.thread.message`, which neither half notifies on
- Cross-device continuity (`backend/routes/continuity.rs`): unsent drafts per `room|channel`, and video resume points. `GET /api/continuity` returns both in one call, fetched on mount and whenever the tab becomes visible. Drafts live in reducer state; resume points live in `resumePointsMap` (a module map beside `screenStreamsMap`) because a playing video reports its position every few seconds and nothing renders it. Scroll position is deliberately absent — read markers already record it
- The composer is a contenteditable div, so its value is a DOM tree and a message is a string. `lib/composer.ts` holds that conversion; `getComposerText` and `setComposerText` must stay exact inverses, since a draft round-trips through them between devices
- Sounds (`backend/sounds.rs`, `lib/sounds.ts`): a room ships a pack replacing the built-in effects (`PACK_EVENTS` / `SoundEvent` — keep the two lists in sync), and a member can set a short entrance sting played when they join a voice channel. Every effect goes through `playSound`, which resolves the room's override then the built-in and applies the listener's own volume; `voice-leave` has no file of its own and is the join sound reversed at runtime, so `resolveSound` answers `null` for it
- A chosen sound is length-checked server-side with ffprobe when it is *set*, never trusted from the client — it plays without anyone asking for it. Only `/external/...` files this instance hosts are allowed. The sting travels with the `voice_user_joined` broadcast, and is empty when the room has entrance sounds off, so a client never decides whether to play one
- A dropped socket leaves a hole: live events are the only thing that puts a message into an open channel. `ws.onopen` therefore treats every connection after the first as a repair, calling `recoverMissedMessages`, which replays from the newest message actually held via `after_ts` and reloads the server-computed unread counts. `after_ts` on `GET /rooms/{id}/messages` is a timestamp range, not an offset page, and its `has_more` means "the gap was wider than one page — ask again from the last message you got"
- A dropped socket leaves a hole in presence as much as in the timeline: a status that changed while it was down was broadcast to nobody, and the ten-second poll only covers the room on screen and only once it next fires. `recoverMissedMessages` therefore refetches presence alongside the voice snapshot and the unread counts, and the tab-resume path does the same
- Themes have two authorities and they do not overlap. A **built-in** is the hand-authored oklch block in `index.css`, and `resolveThemeColors` reads its colours back out with a hidden probe element rather than keeping a second copy in TypeScript — which is why `index.css` aliases `:root`/`.dark` to `[data-theme="light"]`/`[data-theme="dark"]`: matching a rule on the probe is what stops it inheriting the applied theme from `<html>`. A **custom** theme is four colours plus optional overrides, and `deriveThemeVars` turns those into the same variables. It deliberately leaves `--destructive`/`--success`/`--warning`/`--info` unset so they fall through to the base block the theme's `mode` selects
- A theme id reaches a CSS attribute selector (`html[data-theme="..."]`), so it is constrained to `[A-Za-z0-9_-]` on write (`helpers::valid_theme_share_code`, `appearance.rs`) and again wherever one arrives from storage or the network (`isSafeThemeId`). Colours are `#rrggbb` on both sides for the same reason
- Appearance settings sync per user through `GET`/`PUT /api/appearance`. `ThemeSync` pushes nothing until the first fetch answers — a device that pushed first would overwrite the account's settings with the defaults it started on — and `index.html` replays a localStorage cache of the applied theme before first paint, deriving nothing
- A room suggests a theme as a `ct1_` share code on `m.room.theme`, gated by `manage_channels` like the sound pack. It is a suggestion: the client offers it once per code and applies nothing on its own
- Rate limits live in `backend/ratelimit.rs` as token buckets (burst then meter, so pasting three messages is fine and a loop is not), keyed `"<bucket>:<who>"` in an ephemeral `AppState.rate_limits`. Slowmode is the same mechanism with capacity 1 and the channel's period, bypassed by `can_manage_messages` like `read_only`. Refusals go through `helpers::rate_limited`, which always includes `retry_after_secs` — a limit that only says "no" reads as a bug. Registration carries a second instance-wide bucket because the per-address one reads `X-Forwarded-For`, which is only trustworthy behind a proxy
- Moderation is logged: `backend/audit.rs` appends to `audit_log`, read back by owners/moderators at `GET /api/rooms/{room_id}/audit` (paged, `action` filters by prefix — "member" matches every `member.*`). Entries are append-only with no edit or delete route: a log a moderator can rewrite is not a log. `record()` is best effort and its result is ignored on purpose — an action that succeeded must not report failure because the log write did. Details name *which fields changed*, never message bodies; deleting your own message is not logged, only a moderator deleting someone else's
- Server metrics (`backend/metrics.rs`, `GET /api/admin/metrics`, admin only) exist for one question: how much the media plane actually costs. The RTP forwarders count ingress once per publisher packet and egress once per *subscriber* write, using the byte count `write_rtp` reports, so a paused sender adds nothing — the number is egress, not the bitrate the client was configured for. Counters are cumulative and the endpoint computes no rates: the dashboard polls and diffs against `timestamp_ms`, because a window kept server-side is one every later caller has to agree with, and an average hides the spike that saturated the link. The counters live in a global rather than `AppState` because the forwarding tasks are spawned closures that capture only a track and a channel. `media_job()` gauges the ffmpeg passes, which are uncapped and compete for the same cores as forwarding
- `GET /api/admin/export` streams a full logical backup as NDJSON (`{collection, doc}` per line) through an mpsc channel, admin only. It **includes password hashes, TOTP secrets and recovery codes** — a backup that cannot restore logins is not one — and excludes `refresh_tokens`, which would resurrect dead sessions. Uploaded media is not in it; `external/` must be copied alongside
- Threads are records in `threads` (`ThreadRecord`), written where a thread changes — a reply upserts one, bumping `last_activity_ts`, the reply count and the participants. Listings read that, never the messages: `GET /api/rooms/{id}/threads` takes `active_within_ms` and sorts by last activity, which is *not* the root message's timestamp. Both thread paths gate on `channel_permissions`, so a thread is exactly as private as its channel
- A thread reply reaches its participants and anyone named, in the page and via push (`MessageNotification.audience` narrows delivery before policy runs). It does not reach the whole room — a thread is a side conversation. Thread replies carry no `channel_id`, so unread counts exclude `thread_id` or they land in the channel-less bucket
- The channel list previews up to `THREAD_PREVIEW_LIMIT` threads per channel from the last `THREAD_ACTIVE_WINDOW_MS`, updated live from the `m.thread.message` broadcast. It is a recency preview, not an inbox: a thread dropping off must never take an unread mention with it, which is why the notification and the room badge carry that instead
- Blocking is enforced through `helpers::is_blocked_between`, which checks **both** directions — opening a DM, creating or being added to a group DM, and sending into an existing DM. It lived only in `friends.rs` before, so "Block" stopped friend requests and nothing else
- Uploads are removed with what referred to them: redacting a message, deleting a room, and deleting an account (self or admin) all purge files through `media::purge_attachments` / `purge_user_uploads`, sidecars included. A message purge is doubly guarded — only files the sender uploaded, and only when no other unredacted message still references the URL, because the same link can be pasted twice. `attachment_urls` deliberately matches conservatively: missing a file is survivable, deleting one still in use is not
- Mute and deafen belong to the person, not the channel: `joinVoice` preserves both when it is entered while already in a call — a rejoin or a channel switch — silences the fresh track before publishing, and sends them **on the `voice_join` itself** (`muted`/`deafened`), which the server writes into the member record as it registers the arrival. They used to follow the join as two more messages, and each was a second broadcast, so the room saw an open mic on someone who arrived muted and was corrected a moment later. A server mute still wins: `force_muted || joined_muted`
- A dropped socket also ends the call: the server tears voice state down on disconnect, so `ChatLayout` re-issues the join on a *re*-connection when the client still believes it is in a channel. The older sessionStorage rejoin beside it only ever covered a page refresh — it is one-shot per mount and consumes its key on read, so a socket blip reached it never
- A voice stream's cost is mostly headers, not Opus: at the 32 kbps default a 20 ms packet is 80 bytes of payload under ~50 of IP/UDP/RTP/SRTP, and the packet *rate* is what the SFU spends its CPU on — once per listener, not once per speaker. So publishers are asked for 40 ms frames (`VOICE_PTIME_MS`), which halves the packet rate and takes about a fifth off the bandwidth for 20 ms of added latency. For Opus it is the **receiver's** SDP that tells an encoder what to send, and `ptime`/`maxptime` are media-level attributes rather than fmtp parameters, so `mungeVoiceAudioSdp` writes them into the SFU's *answer* before `setRemoteDescription` — the server never negotiates it. `OPUS_FRAME_SAMPLES` is derived from `VOICE_PTIME_MS` rather than written out so the two cannot drift; it is only the fallback advance for a slot handover, so a publisher that ignores the request costs one packet of timestamp skew on a packet that carries the marker bit anyway
- The slot forwarder is the hottest loop in the server — it runs once per packet *per listener* — so it builds its outgoing packet rather than cloning and editing one. Every publisher packet carries the audio-level extension, so `packet.clone()` allocated an extension vector only for the next lines to empty it. `payload` is `Bytes`; carrying it over is a refcount bump. Note `write_rtp` clones again internally and overwrites `ssrc`/`payload_type` per binding, so that second clone is cheap only because the extensions are already gone
- Voice state has one shape and one authority. `voice_channels` on the server is the whole truth, and every event that changes it — join, leave, moderation, a disconnect — carries `voice_states`: the full record (`muted`, `deafened`, `screen_sharing`, `force_muted`, `clipping`) of *everyone left in the channel*, not just the ids. A client replaces the channel outright from that, so one it had never seen is right immediately instead of being invented unmuted
- A voice event describes a change, so one sent while a socket was down reaches nobody and leaves that client wrong with nothing to notice it by. `voice_state_snapshot` answers that: every occupied channel in every room the user belongs to, keyed by channel with its `room_id` and `occupied_since`. It is pushed unasked right after the `connected` ack, and sent again to the one connection that asks with `voice_state_request` — which the client does on opening a room, on coming back from a backgrounded tab, and as `loadVoiceMembers` whenever a socket is open. `GET /api/rooms/{id}/voice` remains the fallback for when one is not, and covers a single room, so a snapshot built from it is applied **scoped to that room** (`SYNC_VOICE_STATE.roomId`) — reading its silence about the others as "empty" would end calls it was never asked about
- Client-side, `voiceChannelMembers` is global, not scoped to the room on screen: a call in another room still has a sidebar row and a DM bar, and your own call keeps its panel while you read elsewhere. `SELECT_ROOM` therefore does not clear it. Everything flat is *derived* from it in the reducer (`deriveRoomVoice`, `withRoomVoiceCounts`) — `voiceMembers`, `voiceMemberStates`, `activeScreenSharers`, and the per-room head-counts the sidebar shows — for the room the client is in a call with, else the one on screen. Two structures maintained side by side from different events is why the member list and the channel list could disagree about who was muted
- WebSocket messages use a `type` field: `typing`, `voice_join`, `voice_leave`, `voice_mute`, `voice_deafen`, `voice_state_request`, `screen_share_start`, `screen_share_stop`
- WebRTC signaling for voice and screen share flows through the WebSocket