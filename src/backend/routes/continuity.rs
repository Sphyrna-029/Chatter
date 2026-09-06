//! State that should follow a person between their devices.
//!
//! Two things are kept here, both small and both per-user: an unsent message
//! draft per channel, and how far through a video someone got. Neither is
//! chat content — nothing is broadcast, and nobody but the owner can read
//! their own — so this is deliberately separate from the message collections.
//!
//! Scroll position is *not* here on purpose: read markers already record where
//! someone had got to, and a second mechanism for the same idea would only
//! disagree with the first.

use super::super::{
    helpers::{error_response, extract_token, get_user_from_token, now_millis},
    state::AppState,
};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::Json,
};
use futures_util::TryStreamExt;
use mongodb::bson::{doc, Document};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

/// Matches the message length the composer and `send_message` allow.
const MAX_DRAFT_LENGTH: usize = 4000;

/// Below this, a video was barely started — resuming would be more surprising
/// than beginning again.
const MIN_RESUME_SECS: f64 = 30.0;

/// Within this of the end, it was effectively watched: remember nothing, so a
/// rewatch starts at the beginning rather than at the credits.
const END_MARGIN_SECS: f64 = 15.0;

/// How long a resume point outlives its last update. Someone who never went
/// back to a video should not still be offered it a year later, and this is
/// what a TTL index on `expires_at` enforces (see `create_indexes`).
const RESUME_TTL_DAYS: i64 = 90;

fn draft_id(user_id: &str, room_id: &str, channel_id: &str) -> String {
    format!("{user_id}|{room_id}|{channel_id}")
}

/// Resume rows are keyed by a hash of the URL: media URLs are long, contain
/// characters awkward in an id, and only ever need equality.
fn resume_id(user_id: &str, url: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(user_id.as_bytes());
    hasher.update([0]);
    hasher.update(url.as_bytes());
    hex::encode(hasher.finalize())
}

/// Everything that should follow the caller to a new device, in one request.
///
/// Both sets are small enough to send whole — one draft per channel the user
/// left something in, and resume points only for videos they are part-way
/// through — so the client can hold them and never ask again.
pub(crate) async fn get_continuity(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let mut drafts: Vec<Value> = Vec::new();
    if let Ok(mut cursor) = state
        .db
        .collection::<Document>("drafts")
        .find(doc! { "user_id": &user_id })
        .await
    {
        while let Ok(Some(d)) = cursor.try_next().await {
            drafts.push(json!({
                "room_id": d.get_str("room_id").unwrap_or(""),
                "channel_id": d.get_str("channel_id").unwrap_or(""),
                "text": d.get_str("text").unwrap_or(""),
                "updated_at": d.get_i64("updated_at").unwrap_or(0),
            }));
        }
    }

    let mut resume: Vec<Value> = Vec::new();
    if let Ok(mut cursor) = state
        .db
        .collection::<Document>("media_resume")
        .find(doc! { "user_id": &user_id })
        .await
    {
        while let Ok(Some(d)) = cursor.try_next().await {
            resume.push(json!({
                "url": d.get_str("url").unwrap_or(""),
                "position_secs": d.get_f64("position_secs").unwrap_or(0.0),
                "duration_secs": d.get_f64("duration_secs").unwrap_or(0.0),
                "updated_at": d.get_i64("updated_at").unwrap_or(0),
            }));
        }
    }

    Ok(Json(json!({ "drafts": drafts, "resume": resume })))
}

#[derive(Deserialize)]
pub(crate) struct SetDraftRequest {
    /// Empty or absent for rooms whose messages carry no channel (DMs).
    pub(crate) channel_id: Option<String>,
    pub(crate) text: String,
}

/// Save, or clear, the caller's unsent draft for one channel.
///
/// An empty draft is a deletion rather than a stored blank: the absence of a
/// row is what "nothing in progress" means, and keeping blanks around would
/// make every channel ever visited a row forever.
pub(crate) async fn set_draft(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
    Json(req): Json<SetDraftRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    {
        let rm = state.room_members.read().await;
        if !rm
            .get(&room_id)
            .map(|m| m.contains(&user_id))
            .unwrap_or(false)
        {
            return Err(error_response(
                StatusCode::FORBIDDEN,
                "Not a member of this room",
            ));
        }
    }

    let channel_id = req.channel_id.unwrap_or_default();
    let id = draft_id(&user_id, &room_id, &channel_id);
    let coll = state.db.collection::<Document>("drafts");

    let text = req.text.trim_end();
    if text.trim().is_empty() {
        let _ = coll.delete_one(doc! { "_id": &id }).await;
        return Ok(Json(json!({ "saved": false })));
    }
    if text.chars().count() > MAX_DRAFT_LENGTH {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "Draft exceeds maximum message length",
        ));
    }

    let _ = coll
        .update_one(
            doc! { "_id": &id },
            doc! { "$set": {
                "user_id": &user_id,
                "room_id": &room_id,
                "channel_id": &channel_id,
                "text": text,
                "updated_at": now_millis(),
            }},
        )
        .upsert(true)
        .await;

    Ok(Json(json!({ "saved": true })))
}

#[derive(Deserialize)]
pub(crate) struct SetResumeRequest {
    pub(crate) url: String,
    pub(crate) position_secs: f64,
    pub(crate) duration_secs: f64,
}

/// Record how far through a video the caller is.
///
/// A position that is barely started, or as good as finished, deletes the row
/// instead of storing it — see `MIN_RESUME_SECS` and `END_MARGIN_SECS`. That
/// is also what keeps this collection bounded without a sweep: rows only
/// survive while someone is genuinely part-way through something.
pub(crate) async fn set_resume_point(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<SetResumeRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    if req.url.trim().is_empty() {
        return Err(error_response(StatusCode::BAD_REQUEST, "url is required"));
    }
    // A non-finite position would poison every later comparison against it.
    if !req.position_secs.is_finite() || !req.duration_secs.is_finite() {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "position_secs and duration_secs must be finite",
        ));
    }

    let id = resume_id(&user_id, &req.url);
    let coll = state.db.collection::<Document>("media_resume");

    if !worth_resuming(req.position_secs, req.duration_secs) {
        let _ = coll.delete_one(doc! { "_id": &id }).await;
        return Ok(Json(json!({ "saved": false })));
    }

    let _ = coll
        .update_one(
            doc! { "_id": &id },
            doc! { "$set": {
                "user_id": &user_id,
                "url": &req.url,
                "position_secs": req.position_secs,
                "duration_secs": req.duration_secs,
                "updated_at": now_millis(),
                // A BSON date, which is what a TTL index can expire on; the
                // millisecond `updated_at` above cannot be used for that.
                "expires_at": mongodb::bson::DateTime::from_millis(
                    now_millis() + RESUME_TTL_DAYS * 86_400_000,
                ),
            }},
        )
        .upsert(true)
        .await;

    Ok(Json(json!({ "saved": true })))
}

/// Whether a position is far enough in, and far enough from the end, to be
/// worth returning to.
fn worth_resuming(position_secs: f64, duration_secs: f64) -> bool {
    if position_secs < MIN_RESUME_SECS {
        return false;
    }
    // A duration of zero means the client could not measure one — trust the
    // position alone rather than discarding it.
    if duration_secs <= 0.0 {
        return true;
    }
    position_secs < duration_secs - END_MARGIN_SECS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn draft_id_is_scoped_per_user_room_and_channel() {
        assert_eq!(draft_id("@a:h", "!r", "#c"), "@a:h|!r|#c");
        // A room-wide draft (a DM) must not collide with a channel one in it.
        assert_ne!(draft_id("@a:h", "!r", ""), draft_id("@a:h", "!r", "#c"));
        assert_ne!(draft_id("@a:h", "!r", "#c"), draft_id("@b:h", "!r", "#c"));
    }

    #[test]
    fn resume_id_separates_users_and_urls() {
        assert_eq!(resume_id("@a:h", "/v.mp4"), resume_id("@a:h", "/v.mp4"));
        assert_ne!(resume_id("@a:h", "/v.mp4"), resume_id("@b:h", "/v.mp4"));
        assert_ne!(resume_id("@a:h", "/v.mp4"), resume_id("@a:h", "/w.mp4"));
        // The user/url boundary is delimited, so these cannot collide.
        assert_ne!(resume_id("@a", "b/v.mp4"), resume_id("@ab", "/v.mp4"));
    }

    #[test]
    fn a_barely_started_video_is_not_worth_resuming() {
        assert!(!worth_resuming(5.0, 600.0));
        assert!(!worth_resuming(MIN_RESUME_SECS - 0.1, 600.0));
        assert!(worth_resuming(MIN_RESUME_SECS, 600.0));
    }

    #[test]
    fn a_finished_video_is_not_worth_resuming() {
        // Sitting on the credits should not send a rewatch to the credits.
        assert!(!worth_resuming(595.0, 600.0));
        assert!(!worth_resuming(600.0, 600.0));
        assert!(worth_resuming(560.0, 600.0));
    }

    #[test]
    fn an_unmeasurable_duration_trusts_the_position() {
        // A live or still-loading source reports duration 0; the position is
        // still real, and discarding it would lose the only thing we know.
        assert!(worth_resuming(120.0, 0.0));
        assert!(!worth_resuming(5.0, 0.0));
    }
}
