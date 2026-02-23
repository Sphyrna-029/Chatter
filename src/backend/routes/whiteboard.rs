use super::super::{
    helpers::{error_response, extract_token, get_user_from_token},
    state::{AppState, RoomRecord, WhiteboardStrokeRecord},
};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::Json,
};
use futures_util::TryStreamExt;
use mongodb::bson::doc;
use serde_json::{json, Value};
use std::sync::Arc;

/// Validate room is whiteboard type and user is a member. Returns user_id.
async fn validate_whiteboard_member(
    state: &AppState,
    headers: &HeaderMap,
    room_id: &str,
) -> Result<String, (StatusCode, Json<Value>)> {
    let token = extract_token(headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let rooms_coll = state.db.collection::<RoomRecord>("rooms");
    let room = rooms_coll
        .find_one(doc! { "_id": room_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Room not found"))?;

    if room.room_type != "whiteboard" {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "Room is not a whiteboard",
        ));
    }

    {
        let rm = state.room_members.read().await;
        if !rm
            .get(room_id)
            .map(|m| m.contains(&user_id))
            .unwrap_or(false)
        {
            return Err(error_response(
                StatusCode::FORBIDDEN,
                "Not a member of this room",
            ));
        }
    }

    Ok(user_id)
}

// ─── Get all strokes for a whiteboard room ──────────────────────────────────

pub(crate) async fn get_strokes(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let _user_id = validate_whiteboard_member(&state, &headers, &room_id).await?;

    let coll = state.db.collection::<WhiteboardStrokeRecord>("whiteboard_strokes");
    let mut strokes: Vec<Value> = Vec::new();

    if let Ok(mut cursor) = coll
        .find(doc! { "room_id": &room_id })
        .sort(doc! { "timestamp": 1 })
        .await
    {
        while let Ok(Some(stroke)) = cursor.try_next().await {
            strokes.push(json!({
                "stroke_id": stroke.stroke_id,
                "room_id": stroke.room_id,
                "user_id": stroke.user_id,
                "tool": stroke.tool,
                "color": stroke.color,
                "width": stroke.width,
                "points": stroke.points,
                "fill": stroke.fill,
                "timestamp": stroke.timestamp,
            }));
        }
    }

    Ok(Json(json!({ "strokes": strokes })))
}
