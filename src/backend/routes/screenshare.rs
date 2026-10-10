//! A still of a live screen share, for the people who cannot see it.
//!
//! Watching a share is opt-in and costs a peer connection, so a member who is
//! *not* in the call has no stream to draw a frame from — yet hovering their
//! name in the members list should still show them what is on screen. This is
//! the one place a share is reduced to a single downscaled JPEG.
//!
//! The server forwards the share as opaque RTP packets and never decodes a
//! frame, so it cannot make the still itself: the sharer's own client, which
//! holds the live capture, writes it here and it is read back verbatim. That
//! keeps the thumbnail honest (it is a real frame, not a guess) and keeps the
//! cost on the one machine already paying to encode the share.
//!
//! Reading is gated to room members, the same guard the members list is drawn
//! under, so a link to a share reveals nothing to anyone outside the room.

use super::super::{
    helpers::{error_response, extract_token, get_user_from_token},
    state::{AppState, RoomRecord},
};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::Json,
};
use mongodb::bson::doc;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

/// A downscaled JPEG is a few tens of kilobytes; anything larger is a client
/// ignoring the contract rather than a share worth posting.
const MAX_THUMBNAIL_BYTES: usize = 96 * 1024;

/// A `data:` URL, not raw base64: the client hands back exactly what
/// `canvas.toDataURL` produced, and the members list drops it straight into an
/// `<img src>`, so storing the prefix means no re-wrapping on either side.
fn is_jpeg_data_url(value: &str) -> bool {
    value.starts_with("data:image/jpeg;base64,") || value.starts_with("data:image/jpg;base64,")
}

#[derive(Deserialize)]
pub(crate) struct ScreenThumbnailRequest {
    pub(crate) thumbnail: String,
}

/// The sharer records a still of their own screen. Only the publisher may write
/// it, and only while they are actually publishing — a share that has gone has
/// nothing to keep a stale frame for.
pub(crate) async fn put_screen_thumbnail(
    State(state): State<Arc<AppState>>,
    Path((room_id, user_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(req): Json<ScreenThumbnailRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let caller = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    // A thumbnail belongs to the person sharing it; nobody else may paint over
    // someone's screen.
    if caller != user_id {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "Not the active sharer",
        ));
    }

    if req.thumbnail.len() > MAX_THUMBNAIL_BYTES || !is_jpeg_data_url(&req.thumbnail) {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "thumbnail must be a JPEG data: URL within the size limit",
        ));
    }

    let mut publishers = state.screen_publishers.write().await;
    match publishers.get_mut(&user_id) {
        Some(publisher) if publisher.room_id == room_id => {
            publisher.thumbnail = Some(req.thumbnail);
        }
        // No live publisher in this room: the share is over or never started, so
        // there is nothing to attach a frame to. Answer quietly rather than
        // failing — the capture loop is fire-and-forget and a share that just
        // ended has no more reason to post than one that has not begun.
        _ => {}
    }

    Ok(Json(json!({ "ok": true })))
}

/// Every still the room's current shares have, keyed by sharer. Read by a
/// member who is not in the call, so the members list can show what is on
/// screen on hover without ever subscribing to the stream.
pub(crate) async fn get_screen_thumbnails(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let room = state
        .db
        .collection::<RoomRecord>("rooms")
        .find_one(doc!( "_id": &room_id ))
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Room not found"))?;
    let _ = room;

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

    let publishers = state.screen_publishers.read().await;
    let mut thumbnails = serde_json::Map::new();
    for (sharer, publisher) in publishers.iter() {
        if publisher.room_id == room_id {
            if let Some(thumbnail) = publisher.thumbnail.as_ref() {
                thumbnails.insert(sharer.clone(), json!(thumbnail));
            }
        }
    }

    Ok(Json(json!({
        "room_id": room_id,
        "thumbnails": Value::Object(thumbnails),
    })))
}
