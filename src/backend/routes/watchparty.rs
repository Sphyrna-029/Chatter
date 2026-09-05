use super::super::{
    helpers::{error_response, extract_token, get_user_from_token},
    state::AppState,
};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::Json,
};
use futures_util::TryStreamExt;
use mongodb::bson::{doc, Document};
use serde_json::{json, Value};
use std::sync::Arc;

/// Reactions are anchored to a position in the video rather than to wall clock,
/// so they stay meaningful on a rewatch. Keep in sync with the cap enforced when
/// one is recorded in ws/session.rs.
pub(crate) const WATCHPARTY_REACTION_LIMIT: i64 = 500;

pub(crate) async fn get_watchparty_state(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let _user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let wp = state.watch_party_rooms.read().await;
    if let Some(s) = wp.get(&room_id) {
        Ok(Json(json!({
            "video_url": s.video_url,
            "playing": s.playing,
            "position_secs": s.position_secs,
            "position_updated_at": s.position_updated_at,
            "duration_secs": s.duration_secs,
            "viewers": s.viewers,
        })))
    } else {
        Ok(Json(json!({
            "video_url": "",
            "playing": false,
            "position_secs": 0.0,
            "position_updated_at": 0.0,
            "duration_secs": 0.0,
            "viewers": Vec::<String>::new(),
        })))
    }
}

/// Reactions recorded against the room's current video, oldest first.
///
/// Scoped to the video that is loaded right now: a different video is a
/// different timeline, and its marks would land at meaningless positions.
pub(crate) async fn get_watchparty_reactions(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let _user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let video_url = {
        let wp = state.watch_party_rooms.read().await;
        wp.get(&room_id)
            .map(|s| s.video_url.clone())
            .unwrap_or_default()
    };
    if video_url.is_empty() {
        return Ok(Json(json!({ "video_url": "", "reactions": [] })));
    }

    let coll = state.db.collection::<Document>("watchparty_reactions");
    let mut reactions: Vec<Value> = Vec::new();
    if let Ok(mut cursor) = coll
        .find(doc! { "room_id": &room_id, "video_url": &video_url })
        .sort(doc! { "position_secs": 1 })
        .limit(WATCHPARTY_REACTION_LIMIT)
        .await
    {
        while let Ok(Some(d)) = cursor.try_next().await {
            reactions.push(json!({
                "reaction_id": d.get_str("_id").unwrap_or(""),
                "user_id": d.get_str("user_id").unwrap_or(""),
                "emoji": d.get_str("emoji").unwrap_or(""),
                "position_secs": d.get_f64("position_secs").unwrap_or(0.0),
                "created_at": d.get_i64("created_at").unwrap_or(0),
            }));
        }
    }

    Ok(Json(
        json!({ "video_url": video_url, "reactions": reactions }),
    ))
}
