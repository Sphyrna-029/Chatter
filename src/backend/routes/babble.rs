use super::super::{
    helpers::{broadcast_to_room, error_response, extract_token, get_user_from_token, get_user_role},
    state::AppState,
};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::Json,
};
use serde_json::{json, Value};
use std::sync::Arc;

/// POST /api/rooms/{room_id}/babble/{user_id}
/// Puts the target user into babble mode for this room. Their messages will
/// appear as random Chinese characters to everyone except owners, moderators,
/// and themselves.
pub(crate) async fn add_babble(
    State(state): State<Arc<AppState>>,
    Path((room_id, target_user_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let caller_role = get_user_role(&state, &room_id, &user_id).await;
    let target_role = get_user_role(&state, &room_id, &target_user_id).await;

    if caller_role == "member" {
        return Err(error_response(StatusCode::FORBIDDEN, "No permission to use babble mode"));
    }
    if target_role == "owner" {
        return Err(error_response(StatusCode::FORBIDDEN, "Cannot babble the owner"));
    }
    if caller_role == "moderator" && target_role == "moderator" {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "Moderators cannot babble other moderators",
        ));
    }

    {
        let mut babbled = state.babbled_users.write().await;
        babbled
            .entry(room_id.clone())
            .or_default()
            .insert(target_user_id.clone());
    }

    let event = json!({
        "type": "m.room.babble",
        "room_id": room_id,
        "user_id": target_user_id,
        "babbled": true,
    });
    broadcast_to_room(&state, &room_id, &event).await;

    Ok(Json(json!({"success": true})))
}

/// DELETE /api/rooms/{room_id}/babble/{user_id}
/// Removes babble mode from the target user.
pub(crate) async fn remove_babble(
    State(state): State<Arc<AppState>>,
    Path((room_id, target_user_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let caller_role = get_user_role(&state, &room_id, &user_id).await;
    let target_role = get_user_role(&state, &room_id, &target_user_id).await;

    if caller_role == "member" {
        return Err(error_response(StatusCode::FORBIDDEN, "No permission to use babble mode"));
    }
    if target_role == "owner" {
        return Err(error_response(StatusCode::FORBIDDEN, "Cannot modify babble for the owner"));
    }
    if caller_role == "moderator" && target_role == "moderator" {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "Moderators cannot modify babble for other moderators",
        ));
    }

    {
        let mut babbled = state.babbled_users.write().await;
        if let Some(room_set) = babbled.get_mut(&room_id) {
            room_set.remove(&target_user_id);
        }
    }

    let event = json!({
        "type": "m.room.babble",
        "room_id": room_id,
        "user_id": target_user_id,
        "babbled": false,
    });
    broadcast_to_room(&state, &room_id, &event).await;

    Ok(Json(json!({"success": true})))
}

/// GET /api/rooms/{room_id}/babbled
/// Returns the list of currently babbled users in this room.
pub(crate) async fn get_babbled_users(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let _user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let babbled_list: Vec<String> = {
        let babbled = state.babbled_users.read().await;
        babbled
            .get(&room_id)
            .map(|s| s.iter().cloned().collect())
            .unwrap_or_default()
    };

    Ok(Json(json!({ "babbled_users": babbled_list })))
}
