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
- Rate limits live in `backend/ratelimit.rs` as token buckets (burst then meter, so pasting three messages is fine and a loop is not), keyed `"<bucket>:<who>"` in an ephemeral `AppState.rate_limits`. Slowmode is the same mechanism with capacity 1 and the channel's period, bypassed by `can_manage_messages` like `read_only`. Refusals go through `helpers::rate_limited`, which always includes `retry_after_secs` — a limit that only says "no" reads as a bug. Registration carries a second instance-wide bucket because the per-address one reads `X-Forwarded-For`, which is only trustworthy behind a proxy
- Moderation is logged: `backend/audit.rs` appends to `audit_log`, read back by owners/moderators at `GET /api/rooms/{room_id}/audit` (paged, `action` filters by prefix — "member" matches every `member.*`). Entries are append-only with no edit or delete route: a log a moderator can rewrite is not a log. `record()` is best effort and its result is ignored on purpose — an action that succeeded must not report failure because the log write did. Details name *which fields changed*, never message bodies; deleting your own message is not logged, only a moderator deleting someone else's
- `GET /api/admin/export` streams a full logical backup as NDJSON (`{collection, doc}` per line) through an mpsc channel, admin only. It **includes password hashes, TOTP secrets and recovery codes** — a backup that cannot restore logins is not one — and excludes `refresh_tokens`, which would resurrect dead sessions. Uploaded media is not in it; `external/` must be copied alongside
- WebSocket messages use a `type` field: `typing`, `voice_join`, `voice_leave`, `voice_mute`, `screen_share_start`, `screen_share_stop`
- WebRTC signaling for voice and screen share flows through the WebSocket