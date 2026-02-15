use super::super::{
    helpers::{error_response, extract_token, get_user_from_token, now_secs},
    state::AppState,
};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::Json,
};
use serde_json::{json, Value};
use std::sync::Arc;

pub(crate) async fn get_voice_channel_status(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let _user_id = get_user_from_token(&state, &token)
        .await
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    if !state.rooms.read().await.contains_key(&room_id) {
        return Err(error_response(StatusCode::NOT_FOUND, "Room not found"));
    }

    let vc = state.voice_channels.read().await;
    let voice_members: Vec<Value> = vc
        .get(&room_id)
        .map(|members| {
            members
                .iter()
                .map(|(uid, vs)| {
                    json!({
                        "user_id": uid,
                        "muted": vs.muted,
                        "screen_sharing": vs.screen_sharing
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(Json(json!({
        "room_id": room_id,
        "voice_members": voice_members
    })))
}

// ---------------------------------------------------------------------------
// Presence
// ---------------------------------------------------------------------------

pub(crate) async fn get_room_presence(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let _user_id = get_user_from_token(&state, &token)
        .await
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    if !state.rooms.read().await.contains_key(&room_id) {
        return Err(error_response(StatusCode::NOT_FOUND, "Room not found"));
    }

    let current_time = now_secs();
    let rm = state.room_members.read().await;
    let up = state.user_presence.read().await;

    let mut presence_data = serde_json::Map::new();

    if let Some(members) = rm.get(&room_id) {
        for member_id in members {
            if let Some(presence) = up.get(member_id) {
                let time_since_typing = current_time - presence.last_typing;
                let status = if !presence.connected {
                    "offline"
                } else if time_since_typing < 300.0 {
                    "active"
                } else {
                    "idle"
                };

                presence_data.insert(
                    member_id.clone(),
                    json!({
                        "status": status,
                        "last_active": presence.last_active,
                        "last_typing": presence.last_typing,
                        "custom_status": presence.custom_status
                    }),
                );
            } else {
                presence_data.insert(
                    member_id.clone(),
                    json!({
                        "status": "offline",
                        "last_active": 0,
                        "last_typing": 0
                    }),
                );
            }
        }
    }

    Ok(Json(json!({
        "room_id": room_id,
        "presence": Value::Object(presence_data)
    })))
}
