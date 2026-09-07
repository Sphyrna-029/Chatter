//! The sounds a server and its members can choose to be heard by.
//!
//! Two features share this: a room's sound pack, which replaces the built-in
//! effects for everyone in that room, and a member's entrance sting, played to
//! a voice channel when they arrive. Both are short audio files already
//! uploaded through the normal media route, referred to here by their
//! `/external/...` URL.
//!
//! What they have in common is the thing worth guarding. A sound plays without
//! anyone asking for it, so an over-long file is not a bad upload — it is a
//! way to hold a channel hostage. Length is therefore checked here, once, when
//! a sound is *chosen*, rather than trusted from the client that chose it.

use super::state::AppState;
use std::sync::Arc;

/// The events a room's pack can replace. Anything not listed is not settable,
/// so a pack cannot invent an event the client will never play.
pub(crate) const PACK_EVENTS: [&str; 5] =
    ["mention", "voice-join", "voice-leave", "mute", "unmute"];

/// The longest a chosen sound may run.
///
/// Everything here interrupts people: a sting fires whenever someone walks
/// into a call, and a pack sound on every mention. Five seconds is enough for
/// a recognisable sting and short enough that a burst of them cannot bury a
/// conversation.
pub(crate) const MAX_SOUND_SECS: f64 = 5.0;

/// Why a sound was refused, phrased for the person who picked it.
pub(crate) enum SoundError {
    /// Not an `/external/...` URL served by this instance.
    NotLocal,
    /// The file is not there, or is not audio this server can read.
    Unreadable,
    TooLong(f64),
}

impl SoundError {
    pub(crate) fn message(&self) -> String {
        match self {
            Self::NotLocal => {
                "Upload the sound to this server first — a link to another site cannot be used"
                    .to_string()
            }
            Self::Unreadable => "That file could not be read as audio".to_string(),
            Self::TooLong(secs) => {
                format!("That sound is {secs:.1}s; the limit is {MAX_SOUND_SECS:.0}s")
            }
        }
    }
}

/// The `/external/...` path a sound URL refers to, whatever form it arrived in.
///
/// The upload endpoint answers with an absolute URL built from the request's
/// Host header, so what a client hands back is `https://host/external/…` while
/// everything here is written in terms of the path. Accepting only the relative
/// form meant every sound a client had just uploaded was refused as "not local".
///
/// Only the path is ever kept. A URL naming some other host contributes nothing
/// but its path, so it cannot make anyone's browser fetch from there, and the
/// file still has to exist on this server's disk to pass the length check.
/// Storing the path rather than the URL also survives the instance changing
/// address, which the absolute form did not.
pub(crate) fn normalize_sound_url(url: &str) -> Option<String> {
    let url = url.trim();
    let path = match url.split_once("://") {
        Some((_, authority_and_path)) => {
            let slash = authority_and_path.find('/')?;
            &authority_and_path[slash..]
        }
        None => url,
    };
    let path = path.split(['?', '#']).next().unwrap_or(path);
    if !path.starts_with("/external/") {
        return None;
    }
    // Resolving it is the traversal check; a path that does not resolve is not
    // one this server will serve.
    external_sound_path(path)?;
    Some(path.to_string())
}

/// Check a chosen sound URL, answering with the form to store, or accept an
/// empty one as "use the default".
///
/// Only files this server hosts are allowed. A remote URL would make every
/// member's browser fetch from somewhere the operator does not control, and
/// its length could change after it was approved.
pub(crate) async fn validate_sound_url(
    state: &Arc<AppState>,
    url: &str,
) -> Result<String, SoundError> {
    let url = url.trim();
    if url.is_empty() {
        return Ok(String::new());
    }
    let Some(normalized) = normalize_sound_url(url) else {
        return Err(SoundError::NotLocal);
    };
    let Some(path) = external_sound_path(&normalized) else {
        return Err(SoundError::NotLocal);
    };
    // Uploads may be behind auth, but this runs on the server's own disk, so
    // the file is read directly rather than fetched back over HTTP.
    let _ = state;

    match audio_duration_secs(&path).await {
        Some(secs) if secs <= MAX_SOUND_SECS => Ok(normalized),
        Some(secs) => Err(SoundError::TooLong(secs)),
        None => Err(SoundError::Unreadable),
    }
}

/// Map an `/external/...` URL to the file on disk, refusing anything that
/// tries to climb out of the uploads directory.
fn external_sound_path(url: &str) -> Option<String> {
    let relative = url.strip_prefix("/external/")?;
    let decoded = percent_encoding::percent_decode_str(relative)
        .decode_utf8()
        .ok()?
        .into_owned();
    if decoded
        .split(['/', '\\'])
        .any(|segment| segment == ".." || segment == ".")
    {
        return None;
    }
    Some(format!("external/{decoded}"))
}

/// The duration ffprobe reports for a file, or None when it is not readable
/// as media at all.
async fn audio_duration_secs(path: &str) -> Option<f64> {
    let output = tokio::process::Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            path,
        ])
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let parsed: f64 = String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse()
        .ok()?;
    // A stream with no measurable duration reports 0 or NaN; neither is a
    // length that can be judged against the cap.
    if !parsed.is_finite() || parsed <= 0.0 {
        return None;
    }
    Some(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_locally_hosted_sounds_resolve() {
        assert_eq!(
            external_sound_path("/external/uploads/u1/ding.wav").as_deref(),
            Some("external/uploads/u1/ding.wav"),
        );
        // A remote file would be fetched from somewhere the operator does not
        // control, and could change length after being approved.
        assert!(external_sound_path("https://elsewhere/ding.wav").is_none());
        assert!(external_sound_path("/uploads/ding.wav").is_none());
    }

    #[test]
    fn the_url_an_upload_answers_with_is_accepted() {
        // The regression: uploads answer with an absolute URL built from the
        // Host header, and only the relative form was accepted, so every sound
        // a client had just uploaded came back "not local".
        assert_eq!(
            normalize_sound_url("https://chat.example.com/external/uploads/u1/ding.wav").as_deref(),
            Some("/external/uploads/u1/ding.wav"),
        );
        assert_eq!(
            normalize_sound_url("http://localhost:8000/external/uploads/u1/ding.wav").as_deref(),
            Some("/external/uploads/u1/ding.wav"),
        );
        // Already a path: unchanged.
        assert_eq!(
            normalize_sound_url("/external/uploads/u1/ding.wav").as_deref(),
            Some("/external/uploads/u1/ding.wav"),
        );
    }

    #[test]
    fn only_the_path_survives_normalising() {
        // Another host contributes its path and nothing else, so what is stored
        // can never send a browser somewhere the operator does not control.
        assert_eq!(
            normalize_sound_url("https://evil.example/external/uploads/u1/ding.wav").as_deref(),
            Some("/external/uploads/u1/ding.wav"),
        );
        // Nothing outside /external is reachable, whatever the host.
        assert!(normalize_sound_url("https://evil.example/ding.wav").is_none());
        assert!(normalize_sound_url("https://evil.example/uploads/ding.wav").is_none());
        // Traversal is still refused once the host is off.
        assert!(normalize_sound_url("https://host/external/../../etc/passwd").is_none());
    }

    #[test]
    fn sound_paths_decode_and_block_traversal() {
        assert_eq!(
            external_sound_path("/external/uploads/u1/My%20Sting.wav").as_deref(),
            Some("external/uploads/u1/My Sting.wav"),
        );
        assert!(external_sound_path("/external/../../etc/passwd").is_none());
        assert!(external_sound_path("/external/uploads/../../secret.wav").is_none());
    }

    #[test]
    fn pack_events_are_the_only_settable_keys() {
        assert!(PACK_EVENTS.contains(&"mention"));
        assert!(PACK_EVENTS.contains(&"voice-join"));
        // An event the client never plays must not be storable.
        assert!(!PACK_EVENTS.contains(&"anything-else"));
    }

    #[test]
    fn refusal_messages_name_the_limit() {
        let msg = SoundError::TooLong(9.4).message();
        assert!(msg.contains("9.4"), "{msg}");
        assert!(msg.contains('5'), "{msg}");
    }
}
