//! Server-side counters, read back by the admin dashboard.
//!
//! The point of these is the media plane. Everything else this process does is
//! IO-bound work with no deadline; the SFU forwards RTP, and its cost — egress
//! bytes above all — is what decides how many people a box can hold. That cost
//! has only ever been estimated from the client's configured bitrates
//! (`lib/webrtc.ts`), which is a ceiling, not a measurement: a screen share
//! tuned to 12 Mbps sends less when the encoder has nothing to encode.
//!
//! Counters are cumulative and monotonic. Rates are deliberately *not* computed
//! here: a window kept server-side is a window every future caller has to agree
//! with, and averaging hides the spike that actually saturated the link. The
//! reader polls twice and divides by the elapsed server clock, which is why the
//! snapshot carries `timestamp_ms`.
//!
//! Every counter is `Relaxed`. They are read for display, never to decide
//! anything, so ordering between them buys nothing and costs a fence on the
//! forwarding path.

use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::LazyLock;
use std::time::{SystemTime, UNIX_EPOCH};

/// Global because the RTP forwarding tasks are spawned closures that capture
/// only the track and the channel — reaching `AppState` from inside them would
/// mean threading a handle through six call sites for the sake of two adds.
/// `MEDIA_JOBS` in `routes/media.rs` sets the same precedent.
pub(crate) static METRICS: LazyLock<Metrics> = LazyLock::new(Metrics::new);

/// Force initialisation at startup so `uptime_secs` measures the process, not
/// the time since the first packet was forwarded.
pub(crate) fn init() {
    LazyLock::force(&METRICS);
}

#[derive(Clone, Copy)]
pub(crate) enum MediaKind {
    Voice,
    Screen,
    Webcam,
}

#[derive(Default)]
struct StreamCounters {
    in_packets: AtomicU64,
    in_bytes: AtomicU64,
    out_packets: AtomicU64,
    out_bytes: AtomicU64,
    /// Packets a subscriber never saw because it fell behind the publisher's
    /// broadcast ring. Non-zero means the ring is too small, the subscriber's
    /// link is too slow, or the process is starved — all three worth seeing.
    lagged_packets: AtomicU64,
}

impl StreamCounters {
    fn snapshot(&self) -> Value {
        json!({
            "in_packets": self.in_packets.load(Ordering::Relaxed),
            "in_bytes": self.in_bytes.load(Ordering::Relaxed),
            "out_packets": self.out_packets.load(Ordering::Relaxed),
            "out_bytes": self.out_bytes.load(Ordering::Relaxed),
            "lagged_packets": self.lagged_packets.load(Ordering::Relaxed),
        })
    }
}

#[derive(Default)]
struct MediaJobCounters {
    active: AtomicU64,
    started: AtomicU64,
}

pub(crate) struct Metrics {
    started_at_ms: u64,
    voice: StreamCounters,
    screen: StreamCounters,
    webcam: StreamCounters,
    media_jobs: MediaJobCounters,
}

impl Metrics {
    fn new() -> Self {
        Self {
            started_at_ms: now_ms(),
            voice: StreamCounters::default(),
            screen: StreamCounters::default(),
            webcam: StreamCounters::default(),
            media_jobs: MediaJobCounters::default(),
        }
    }

    fn kind(&self, kind: MediaKind) -> &StreamCounters {
        match kind {
            MediaKind::Voice => &self.voice,
            MediaKind::Screen => &self.screen,
            MediaKind::Webcam => &self.webcam,
        }
    }

    /// One packet read from a publisher's track. Counted before the fan-out, so
    /// ingress is per publisher and not multiplied by the audience.
    pub(crate) fn record_in(&self, kind: MediaKind, bytes: usize) {
        let c = self.kind(kind);
        c.in_packets.fetch_add(1, Ordering::Relaxed);
        c.in_bytes.fetch_add(bytes as u64, Ordering::Relaxed);
    }

    /// One packet written towards a subscriber. `bytes` is what the track
    /// reported actually writing across its bindings, so a paused sender adds
    /// nothing — the number is egress, not intent.
    pub(crate) fn record_out(&self, kind: MediaKind, bytes: usize) {
        if bytes == 0 {
            return;
        }
        let c = self.kind(kind);
        c.out_packets.fetch_add(1, Ordering::Relaxed);
        c.out_bytes.fetch_add(bytes as u64, Ordering::Relaxed);
    }

    pub(crate) fn record_lagged(&self, kind: MediaKind, packets: u64) {
        self.kind(kind)
            .lagged_packets
            .fetch_add(packets, Ordering::Relaxed);
    }

    pub(crate) fn snapshot(&self) -> Value {
        json!({
            "uptime_secs": now_ms().saturating_sub(self.started_at_ms) / 1000,
            "voice": self.voice.snapshot(),
            "screen": self.screen.snapshot(),
            "webcam": self.webcam.snapshot(),
            "media_jobs": {
                "active": self.media_jobs.active.load(Ordering::Relaxed),
                "started": self.media_jobs.started.load(Ordering::Relaxed),
            },
        })
    }
}

/// Marks an ffmpeg/ffprobe pass as running for as long as it is held.
///
/// A gauge rather than a duration because the question it answers is "was
/// anything transcoding while that call stuttered" — these passes compete for
/// the same cores as RTP forwarding, and nothing caps how many run at once.
pub(crate) struct MediaJobGuard;

pub(crate) fn media_job() -> MediaJobGuard {
    METRICS.media_jobs.active.fetch_add(1, Ordering::Relaxed);
    METRICS.media_jobs.started.fetch_add(1, Ordering::Relaxed);
    MediaJobGuard
}

impl Drop for MediaJobGuard {
    fn drop(&mut self) {
        METRICS.media_jobs.active.fetch_sub(1, Ordering::Relaxed);
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Resident set size of this process, in bytes.
///
/// Read from `/proc` rather than taken from an allocator hook: the memory that
/// matters here is the RTP rings and the WebRTC stack's buffers, most of which
/// are allocated once per publisher and held. Assumes a 4 KiB page, which is
/// what the container this ships in runs on. `None` off Linux, where the
/// dashboard simply omits the row.
pub(crate) fn resident_bytes() -> Option<u64> {
    #[cfg(target_os = "linux")]
    {
        let statm = std::fs::read_to_string("/proc/self/statm").ok()?;
        // Second field is resident pages.
        let pages: u64 = statm.split_whitespace().nth(1)?.parse().ok()?;
        Some(pages * 4096)
    }
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ingress_counts_once_per_packet_and_egress_once_per_subscriber() {
        let m = Metrics::new();
        // One publisher packet fanned out to three subscribers: ingress is
        // counted once, egress three times. Reading them the other way round
        // is what makes a server look like it has spare capacity.
        m.record_in(MediaKind::Screen, 1200);
        for _ in 0..3 {
            m.record_out(MediaKind::Screen, 1200);
        }
        let snap = m.snapshot();
        assert_eq!(snap["screen"]["in_packets"], 1);
        assert_eq!(snap["screen"]["in_bytes"], 1200);
        assert_eq!(snap["screen"]["out_packets"], 3);
        assert_eq!(snap["screen"]["out_bytes"], 3600);
    }

    #[test]
    fn a_paused_sender_writes_nothing_and_is_not_counted() {
        let m = Metrics::new();
        m.record_out(MediaKind::Voice, 0);
        let snap = m.snapshot();
        assert_eq!(snap["voice"]["out_packets"], 0);
        assert_eq!(snap["voice"]["out_bytes"], 0);
    }

    #[test]
    fn kinds_are_counted_separately() {
        let m = Metrics::new();
        m.record_out(MediaKind::Voice, 100);
        m.record_out(MediaKind::Webcam, 200);
        m.record_lagged(MediaKind::Webcam, 7);
        let snap = m.snapshot();
        assert_eq!(snap["voice"]["out_bytes"], 100);
        assert_eq!(snap["screen"]["out_bytes"], 0);
        assert_eq!(snap["webcam"]["out_bytes"], 200);
        assert_eq!(snap["webcam"]["lagged_packets"], 7);
        assert_eq!(snap["voice"]["lagged_packets"], 0);
    }

    #[test]
    fn a_media_job_is_active_only_while_its_guard_lives() {
        // Deltas, not absolutes: the gauge is global and other tests share it.
        let active = || METRICS.media_jobs.active.load(Ordering::Relaxed);
        let before = active();
        {
            let _job = media_job();
            assert_eq!(active(), before + 1);
        }
        assert_eq!(active(), before);
    }
}
