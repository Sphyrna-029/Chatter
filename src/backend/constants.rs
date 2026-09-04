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
pub(crate) const VOICE_BITRATE_DEFAULT: i32 = 64_000;
