//! Rate limiting, and the slowmode built on top of it.
//!
//! Until now the only limiter in the server was on TOTP attempts, which means
//! a single script could fill the message collection, the upload directory or
//! the user table. On a self-hosted instance the person that costs is the
//! person who deployed it, so the defaults here are chosen to be invisible to
//! a human and immediately felt by a loop.
//!
//! Buckets are token buckets rather than fixed windows: a fixed window lets
//! twice the quota through across a boundary, and — more importantly here —
//! refuses a burst that a person legitimately produces, like pasting three
//! messages in a row. A bucket allows the burst and then meters the rate.
//!
//! Slowmode is the same mechanism with a capacity of one and a refill period
//! the channel chooses, which is exactly what "one message every N seconds"
//! means.

use super::{helpers::now_secs, state::AppState};
use std::sync::Arc;

/// How much a caller may do at once, and how fast that recovers.
#[derive(Clone, Copy)]
pub(crate) struct Quota {
    /// Burst size: how many actions are allowed back to back.
    pub(crate) capacity: f64,
    /// How many actions are restored per second once the burst is spent.
    pub(crate) refill_per_sec: f64,
}

impl Quota {
    /// `count` actions per `secs`, allowing the whole count as a burst.
    const fn per(count: f64, secs: f64) -> Self {
        Self {
            capacity: count,
            refill_per_sec: count / secs,
        }
    }
}

/// Sending messages. Comfortably above a fast typist, far below a loop.
pub(crate) const SEND_MESSAGE: Quota = Quota::per(15.0, 10.0);
/// Uploads are expensive: disk, ffprobe, thumbnailing, transcoding.
pub(crate) const UPLOAD: Quota = Quota::per(10.0, 60.0);
/// Registration, keyed per address rather than per user — there is no user yet.
pub(crate) const REGISTER: Quota = Quota::per(5.0, 3600.0);
/// Registration for the whole instance, regardless of address.
///
/// The per-address limit above is best effort: the address comes from
/// `X-Forwarded-For` when one is present, which is only trustworthy behind a
/// proxy the operator controls, and is attacker-chosen when it is not. This
/// second bucket cannot be evaded by picking a new address, so a spoofed
/// header buys a burst rather than an unlimited supply of accounts.
pub(crate) const REGISTER_GLOBAL: Quota = Quota::per(30.0, 3600.0);
/// Friend requests, which are unsolicited by nature.
pub(crate) const FRIEND_REQUEST: Quota = Quota::per(20.0, 3600.0);
/// Reactions: cheap individually, and a loop can write thousands.
pub(crate) const REACTION: Quota = Quota::per(30.0, 10.0);
/// Invite creation, which mints credentials to the room.
pub(crate) const CREATE_INVITE: Quota = Quota::per(10.0, 600.0);

/// Above this many tracked buckets, spent-and-recovered entries are dropped.
/// Buckets are created per key, so an unbounded map is itself an attack.
const SWEEP_THRESHOLD: usize = 10_000;

#[derive(Clone, Copy)]
pub(crate) struct Bucket {
    tokens: f64,
    last_refill: f64,
}

/// Take one token from `key`'s bucket.
///
/// Returns `Err(retry_after_secs)` when the bucket is empty. Callers should
/// surface that number: a limit that says only "no" is indistinguishable from
/// a bug.
pub(crate) async fn check(state: &Arc<AppState>, key: &str, quota: Quota) -> Result<(), f64> {
    let now = now_secs();
    let mut buckets = state.rate_limits.write().await;

    if buckets.len() > SWEEP_THRESHOLD {
        // A full bucket is one nobody is currently limited by, so dropping it
        // loses nothing — it would be recreated full anyway.
        buckets.retain(|_, bucket| {
            let refilled = bucket.tokens + (now - bucket.last_refill) * quota.refill_per_sec;
            refilled < quota.capacity
        });
    }

    let bucket = buckets.entry(key.to_string()).or_insert(Bucket {
        tokens: quota.capacity,
        last_refill: now,
    });

    // Refill for the time since the last take, capped at the burst size.
    let elapsed = (now - bucket.last_refill).max(0.0);
    bucket.tokens = (bucket.tokens + elapsed * quota.refill_per_sec).min(quota.capacity);
    bucket.last_refill = now;

    if bucket.tokens >= 1.0 {
        bucket.tokens -= 1.0;
        return Ok(());
    }

    // How long until one whole token exists again.
    let deficit = 1.0 - bucket.tokens;
    Err(deficit / quota.refill_per_sec)
}

/// Slowmode: at most one message per `secs` in a channel, per member.
///
/// Expressed as a quota so it shares the bucket machinery. Capacity is one
/// deliberately — slowmode that allowed a burst would not be slowmode.
pub(crate) async fn check_slowmode(
    state: &Arc<AppState>,
    channel_id: &str,
    user_id: &str,
    secs: u32,
) -> Result<(), f64> {
    if secs == 0 {
        return Ok(());
    }
    let quota = Quota {
        capacity: 1.0,
        refill_per_sec: 1.0 / f64::from(secs),
    };
    check(state, &format!("slow:{channel_id}:{user_id}"), quota).await
}

/// Retry-after seconds, rounded up to something worth showing a person.
pub(crate) fn retry_after_secs(retry_after: f64) -> u64 {
    retry_after.ceil().max(1.0) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Drive a bucket directly, without the AppState the async path needs.
    fn take(bucket: &mut Bucket, quota: Quota, now: f64) -> Result<(), f64> {
        let elapsed = (now - bucket.last_refill).max(0.0);
        bucket.tokens = (bucket.tokens + elapsed * quota.refill_per_sec).min(quota.capacity);
        bucket.last_refill = now;
        if bucket.tokens >= 1.0 {
            bucket.tokens -= 1.0;
            return Ok(());
        }
        Err((1.0 - bucket.tokens) / quota.refill_per_sec)
    }

    fn fresh(quota: Quota) -> Bucket {
        Bucket {
            tokens: quota.capacity,
            last_refill: 0.0,
        }
    }

    #[test]
    fn a_burst_up_to_capacity_is_allowed() {
        // Pasting several messages in a row is something people do; it must
        // not be mistaken for a loop.
        let quota = Quota::per(15.0, 10.0);
        let mut bucket = fresh(quota);
        for _ in 0..15 {
            assert!(take(&mut bucket, quota, 0.0).is_ok());
        }
        assert!(take(&mut bucket, quota, 0.0).is_err());
    }

    #[test]
    fn the_bucket_refills_over_time() {
        let quota = Quota::per(10.0, 10.0); // one per second
        let mut bucket = fresh(quota);
        for _ in 0..10 {
            assert!(take(&mut bucket, quota, 0.0).is_ok());
        }
        assert!(take(&mut bucket, quota, 0.0).is_err());
        // One second later, exactly one more is available.
        assert!(take(&mut bucket, quota, 1.0).is_ok());
        assert!(take(&mut bucket, quota, 1.0).is_err());
    }

    #[test]
    fn refill_never_exceeds_the_burst_size() {
        // An hour idle must not bank an hour's worth of sends.
        let quota = Quota::per(10.0, 10.0);
        let mut bucket = fresh(quota);
        assert!(take(&mut bucket, quota, 3600.0).is_ok());
        for _ in 0..9 {
            assert!(take(&mut bucket, quota, 3600.0).is_ok());
        }
        assert!(take(&mut bucket, quota, 3600.0).is_err());
    }

    #[test]
    fn the_wait_reported_is_how_long_until_one_token() {
        let quota = Quota::per(10.0, 10.0); // one per second
        let mut bucket = fresh(quota);
        for _ in 0..10 {
            let _ = take(&mut bucket, quota, 0.0);
        }
        let wait = take(&mut bucket, quota, 0.0).unwrap_err();
        assert!((wait - 1.0).abs() < 0.001, "expected ~1s, got {wait}");
    }

    #[test]
    fn slowmode_allows_one_then_makes_you_wait() {
        let quota = Quota {
            capacity: 1.0,
            refill_per_sec: 1.0 / 30.0,
        };
        let mut bucket = fresh(quota);
        assert!(take(&mut bucket, quota, 0.0).is_ok());
        assert!(take(&mut bucket, quota, 10.0).is_err());
        // And exactly at the period, one more.
        assert!(take(&mut bucket, quota, 30.0).is_ok());
    }

    #[test]
    fn retry_after_is_rounded_up_and_never_zero() {
        // "Try again in 0 seconds" reads as a bug.
        assert_eq!(retry_after_secs(0.01), 1);
        assert_eq!(retry_after_secs(1.2), 2);
        assert_eq!(retry_after_secs(30.0), 30);
    }
}
