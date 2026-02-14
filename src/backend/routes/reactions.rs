use super::super::{
    dto::ReactionRequest,
    helpers::{broadcast_to_room, error_response, extract_token, generate_id, get_user_from_token},
    state::AppState,
};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::Json,
};
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Arc};

pub(crate) async fn add_reaction(
    State(state): State<Arc<AppState>>,
    Path((room_id, event_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(req): Json<ReactionRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .await
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    if !state.rooms.read().await.contains_key(&room_id) {
        return Err(error_response(StatusCode::NOT_FOUND, "Room not found"));
    }

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

    let emoji = req
        .emoji
        .ok_or_else(|| error_response(StatusCode::BAD_REQUEST, "Emoji required"))?;

    let (action, reactions_snapshot) = {
        let mut reactions = state.message_reactions.write().await;
        let event_reactions = reactions
            .entry(event_id.clone())
            .or_insert_with(HashMap::new);
        let emoji_users = event_reactions
            .entry(emoji.clone())
            .or_insert_with(Vec::new);

        let action = if let Some(pos) = emoji_users.iter().position(|u| u == &user_id) {
            emoji_users.remove(pos);
            if emoji_users.is_empty() {
                event_reactions.remove(&emoji);
            }
            "removed"
        } else {
            emoji_users.push(user_id.clone());
            "added"
        };

        // Clone the current reactions for broadcast
        let snap: HashMap<String, Vec<String>> =
            reactions.get(&event_id).cloned().unwrap_or_default();
        (action.to_string(), snap)
    };

    let reactions_value = serde_json::to_value(&reactions_snapshot).unwrap();

    let broadcast_msg = json!({
        "type": "m.reaction",
        "room_id": room_id,
        "event_id": event_id,
        "emoji": emoji,
        "user_id": user_id,
        "action": action,
        "reactions": reactions_value
    });

    broadcast_to_room(&state, &room_id, &broadcast_msg).await;

    Ok(Json(json!({
        "event_id": generate_id("$"),
        "reactions": reactions_value
    })))
}

pub(crate) async fn get_reactions(
    State(state): State<Arc<AppState>>,
    Path((room_id, event_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let _ = room_id;
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let _user_id = get_user_from_token(&state, &token)
        .await
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let reactions = state.message_reactions.read().await;
    let event_reactions = reactions.get(&event_id).cloned().unwrap_or_default();

    Ok(Json(json!({
        "event_id": event_id,
        "reactions": event_reactions
    })))
}
