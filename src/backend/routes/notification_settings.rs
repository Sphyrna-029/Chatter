//! Per-user notification preferences, scoped to a room or a single channel.
//!
//! The server does not withhold messages based on these — a member still
//! receives everything they are entitled to see. The level only decides
//! whether the client raises a notification for a message, so muting is a
//! preference that follows the user across devices rather than a filter.

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
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

/// Levels a user can choose. "default" is not stored — it deletes the override
/// so the next level up applies (channel → room → "all").
const LEVELS: [&str; 3] = ["all", "mentions", "none"];

#[derive(Deserialize)]
pub(crate) struct SetNotificationLevelRequest {
    /// Empty or absent targets the whole room.
    pub(crate) channel_id: Option<String>,
    pub(crate) level: String,
}

fn setting_id(user_id: &str, room_id: &str, channel_id: &str) -> String {
    format!("{user_id}|{room_id}|{channel_id}")
}

pub(crate) async fn get_notification_settings(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let coll = state.db.collection::<Document>("notification_settings");
    let mut settings: Vec<Value> = Vec::new();
    if let Ok(mut cursor) = coll.find(doc! { "user_id": &user_id }).await {
        while let Ok(Some(d)) = cursor.try_next().await {
            settings.push(json!({
                "room_id": d.get_str("room_id").unwrap_or(""),
                "channel_id": d.get_str("channel_id").unwrap_or(""),
                "level": d.get_str("level").unwrap_or("all"),
            }));
        }
    }

    Ok(Json(json!({ "settings": settings })))
}

pub(crate) async fn set_notification_level(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
    Json(req): Json<SetNotificationLevelRequest>,
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
    let id = setting_id(&user_id, &room_id, &channel_id);
    let coll = state.db.collection::<Document>("notification_settings");

    if req.level == "default" {
        let _ = coll.delete_one(doc! { "_id": &id }).await;
        return Ok(Json(json!({ "level": "default" })));
    }

    if !LEVELS.contains(&req.level.as_str()) {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "Level must be one of: all, mentions, none, default",
        ));
    }

    let _ = coll
        .update_one(
            doc! { "_id": &id },
            doc! { "$set": {
                "user_id": &user_id,
                "room_id": &room_id,
                "channel_id": &channel_id,
                "level": &req.level,
            }},
        )
        .upsert(true)
        .await;

    Ok(Json(json!({ "level": req.level })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn setting_id_separates_room_and_channel_scope() {
        assert_eq!(setting_id("@a:h", "!r", ""), "@a:h|!r|");
        assert_eq!(setting_id("@a:h", "!r", "#c"), "@a:h|!r|#c");
        // A room-wide setting must not collide with a channel override in it.
        assert_ne!(setting_id("@a:h", "!r", ""), setting_id("@a:h", "!r", "#c"));
    }

    #[test]
    fn only_known_levels_are_storable() {
        assert!(LEVELS.contains(&"all"));
        assert!(LEVELS.contains(&"mentions"));
        assert!(LEVELS.contains(&"none"));
        // "default" is handled by deletion, never written as a level.
        assert!(!LEVELS.contains(&"default"));
    }
}
