pub(crate) const SCREEN_RTP_BUFFER_SIZE: usize = 16384;
pub(crate) const SCREEN_AUDIO_RTP_BUFFER_SIZE: usize = 4096;
pub(crate) const WEBCAM_RTP_BUFFER_SIZE: usize = 8192;
pub(crate) const VOICE_RTP_BUFFER_SIZE: usize = 256;
pub(crate) const MIN_USERNAME_LENGTH: usize = 3;
pub(crate) const MAX_USERNAME_LENGTH: usize = 42;
pub(crate) const CHUNK_SIZE: usize = 10 * 1024 * 1024; // 10MB

// Voice channel Opus bitrate bounds, in bits per second.
pub(crate) const VOICE_BITRATE_MIN: i32 = 8_000;
pub(crate) const VOICE_BITRATE_MAX: i32 = 256_000;
pub(crate) const VOICE_BITRATE_DEFAULT: i32 = 32_000;

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

/// Samples in one 20 ms Opus frame at 48 kHz. Used to advance a slot's
/// timestamp when it changes hands and there is no input delta to carry over.
pub(crate) const OPUS_FRAME_SAMPLES: u32 = 960;

/// Largest input timestamp jump carried through to a slot's output. Anything
/// beyond a second is treated as a discontinuity rather than trusted.
pub(crate) const VOICE_MAX_TS_DELTA: u32 = 48_000;
