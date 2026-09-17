pub(crate) const SCREEN_RTP_BUFFER_SIZE: usize = 16384;
pub(crate) const SCREEN_AUDIO_RTP_BUFFER_SIZE: usize = 4096;
pub(crate) const WEBCAM_RTP_BUFFER_SIZE: usize = 8192;
pub(crate) const VOICE_RTP_BUFFER_SIZE: usize = 256;
pub(crate) const MIN_USERNAME_LENGTH: usize = 3;
pub(crate) const MAX_USERNAME_LENGTH: usize = 42;
pub(crate) const CHUNK_SIZE: usize = 10 * 1024 * 1024; // 10MB

// ─── Chunked upload staging ─────────────────────────────────────────────────
// `upload_init` creates a staging dir per upload and only `upload_complete`
// removes it, so an upload whose client walked away — a closed tab, a dead
// connection, a failure it gave up on — left its chunks on disk for good. At
// 10MB a chunk that is a large leak from a small number of abandoned uploads.

/// How often the staging area is swept for uploads nobody is going to finish.
pub(crate) const CHUNK_SWEEP_SECS: u64 = 60 * 60;

/// How long a staging dir may go untouched before it counts as abandoned.
///
/// Measured from the most recently written chunk, not from the init, so a
/// genuinely slow upload is never reaped out from under itself. Generous
/// against the client's own limits — two minutes per chunk and three tries —
/// because the cost of waiting is disk and the cost of being wrong is somebody
/// losing an upload in progress.
pub(crate) const CHUNK_ABANDONED_SECS: u64 = 24 * 60 * 60;

// ─── Reclaiming uploads nothing kept ────────────────────────────────────────
// An upload that completes but is never posted — the send failed, the tab
// closed, the profile save errored after the avatar went up — leaves a file on
// disk and a record in the database for good, consuming the uploader's quota.
// Nothing referred to it and nothing ever will, but nothing could tell.

/// How often uploads nothing kept are looked for.
pub(crate) const UPLOAD_SWEEP_SECS: u64 = 60 * 60;

/// How long an upload has to be claimed by something before it is treated as
/// abandoned.
///
/// Every surface uploads seconds before it references the URL, so a day is
/// enormously generous — which is the point. This is the one number that could
/// delete something real, and the cost of waiting another day is disk.
pub(crate) const UPLOAD_GRACE_SECS: i64 = 24 * 60 * 60;

/// How many candidates one pass will consider.
///
/// Bounded because the first pass after this shipped has every upload made
/// before claims existed to work through, and one hour's sweep should not turn
/// into a scan of the whole history. The backlog drains over days.
pub(crate) const UPLOAD_SWEEP_BATCH: usize = 200;

// Voice channel Opus bitrate bounds, in bits per second.
pub(crate) const VOICE_BITRATE_MIN: i32 = 8_000;
pub(crate) const VOICE_BITRATE_MAX: i32 = 256_000;
pub(crate) const VOICE_BITRATE_DEFAULT: i32 = 32_000;

// ─── Profile theming ────────────────────────────────────────────────────────
// A person's own colour, shown to everyone who looks at their profile. Bounds
// live here because both the validator and the record's defaults need them.

/// How far the colour travels before it is gone, as a percentage of the
/// surface: 0 is a flat wash, 100 fades across the whole thing.
pub(crate) const PROFILE_FADE_DEFAULT: i32 = 70;
pub(crate) const PROFILE_FADE_MIN: i32 = 0;
pub(crate) const PROFILE_FADE_MAX: i32 = 100;

/// Which way the fade runs. A closed set because it reaches a CSS gradient.
pub(crate) const PROFILE_FADE_DIRECTIONS: [&str; 4] = ["down", "up", "left", "right"];
pub(crate) const PROFILE_FADE_DIRECTION_DEFAULT: &str = "down";

// ─── Voice speaker slots ────────────────────────────────────────────────────
// The SFU forwards only the loudest few speakers into a fixed set of slots on
// each listener's single connection. That is what stops a call's cost growing
// with its size: connections scale with the number of people, and bandwidth
// with the slot count rather than the headcount.

/// How many speakers one listener can hear at once. More than a handful
/// talking over each other is unintelligible anyway.
pub(crate) const VOICE_MAX_ACTIVE_SPEAKERS: usize = 12;

/// How often speaker ranking is recomputed, in milliseconds.
pub(crate) const VOICE_SPEAKER_REFRESH_MS: u64 = 200;

/// How long a speaker keeps their slot after they stop talking. Without a hold
/// window, two people trading short remarks would swap slots continuously.
pub(crate) const VOICE_SPEAKER_HOLD_MS: u64 = 2_000;

/// RTP audio level, in -dBov (0 loudest, 127 silence), at or below which a
/// packet counts as speech.
pub(crate) const VOICE_ACTIVITY_DBOV_THRESHOLD: u8 = 50;

/// How much audio a publisher puts in one packet, in milliseconds.
///
/// The wire cost of a voice stream is dominated by per-packet headers, not by
/// Opus: at the 32 kbps default a 20 ms packet is 80 bytes of payload under 50
/// bytes of IP/UDP/RTP/SRTP. Doubling the frame therefore takes about a fifth
/// off the bandwidth — and, more to the point, halves the packet rate, which is
/// what the SFU actually spends its CPU on, once per listener. 40 ms buys that
/// for 20 ms of added latency against a mouth-to-ear budget of roughly 150.
///
/// The server does not negotiate this: for Opus it is the receiver's SDP that
/// tells an encoder what to send, so the value is applied client-side by
/// `mungeVoiceAudioSdp`. Keep it in step with `VOICE_PTIME_MS` in
/// `client/src/lib/webrtc.ts`.
pub(crate) const VOICE_PTIME_MS: u32 = 40;

/// Samples in one Opus frame at 48 kHz. Used to advance a slot's timestamp when
/// it changes hands and there is no input delta to carry over.
///
/// Derived from the packetisation rather than written out, so the two cannot
/// drift. A publisher that ignores the requested ptime only costs a single
/// packet's worth of timestamp skew at a handover, which carries the marker bit
/// telling the decoder to reset anyway.
pub(crate) const OPUS_FRAME_SAMPLES: u32 = 48 * VOICE_PTIME_MS;

// ─── Presence ───────────────────────────────────────────────────────────────

/// How often connected users are re-examined for a status change.
///
/// Going idle is the one presence transition nothing announces: it is the
/// absence of activity, so no event marks it and no client can work it out
/// about somebody else. Every other transition — connecting, disconnecting,
/// a manual or custom status, a profile edit, going active again — broadcasts
/// where it happens, which is why this is the only clock presence needs.
///
/// Short, because the sweep is what makes idle feel live and it costs almost
/// nothing to run: it reads two in-memory maps, compares each connected user's
/// status to the one last announced, and sends only where that differs. No
/// query, no request, and nothing on the wire on a quiet server. Clients used
/// to poll a room's whole roster every ten seconds to cover this, which was
/// both slower and immeasurably more expensive — and only ever covered the one
/// room on screen, so someone going idle elsewhere stayed active in the
/// sidebar until the sweep caught up.
pub(crate) const PRESENCE_SWEEP_SECS: u64 = 5;

/// Largest input timestamp jump carried through to a slot's output. Anything
/// beyond a second is treated as a discontinuity rather than trusted.
pub(crate) const VOICE_MAX_TS_DELTA: u32 = 48_000;
