use super::super::{
    helpers::{error_response, extract_token, get_user_from_token},
    state::AppState,
};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::Json,
};
use serde_json::{json, Value};
use std::sync::Arc;

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
