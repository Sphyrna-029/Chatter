use super::super::{
    dto::ReactionRequest,
    helpers::{
        broadcast_to_room, effective_permissions, error_response, extract_token, generate_id,
        get_user_from_token, rate_limited,
    },
    ratelimit,
    state::{AppState, ReactionRecord, RoomRecord},
};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::Json,
};
use futures_util::TryStreamExt;
use mongodb::bson::doc;
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
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    if let Err(retry_after) =
        ratelimit::check(&state, &format!("react:{user_id}"), ratelimit::REACTION).await
    {
        return Err(rate_limited(retry_after, "You are reacting too quickly"));
    }

    let rooms_coll = state.db.collection::<RoomRecord>("rooms");
    if rooms_coll
        .find_one(doc! { "_id": &room_id })
        .await
        .ok()
        .flatten()
        .is_none()
    {
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

    if !effective_permissions(&state, &room_id, &user_id)
        .await
        .add_reactions
    {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "You do not have permission to add reactions in this room",
        ));
    }

    let emoji = req
        .emoji
        .ok_or_else(|| error_response(StatusCode::BAD_REQUEST, "Emoji required"))?;

    let react_coll = state.db.collection::<ReactionRecord>("reactions");

    // Toggle: try to delete existing, if nothing deleted then insert
    let delete_result = react_coll
        .delete_one(doc! {
            "event_id": &event_id,
            "emoji": &emoji,
            "user_id": &user_id
        })
        .await;

    let action = if delete_result.map(|r| r.deleted_count > 0).unwrap_or(false) {
        "removed"
    } else {
        let _ = react_coll
            .insert_one(ReactionRecord {
                event_id: event_id.clone(),
                emoji: emoji.clone(),
                user_id: user_id.clone(),
            })
            .await;
        "added"
    };

    // Build current reactions snapshot from MongoDB
    let reactions_snapshot = get_reactions_for_event(&state, &event_id).await;
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
    Path((_room_id, event_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let _user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let reactions = get_reactions_for_event(&state, &event_id).await;

    Ok(Json(json!({
        "event_id": event_id,
        "reactions": reactions
    })))
}

async fn get_reactions_for_event(state: &AppState, event_id: &str) -> HashMap<String, Vec<String>> {
    let react_coll = state.db.collection::<ReactionRecord>("reactions");
    let mut reactions: HashMap<String, Vec<String>> = HashMap::new();

    if let Ok(mut cursor) = react_coll.find(doc! { "event_id": event_id }).await {
        while let Ok(Some(record)) = cursor.try_next().await {
            reactions
                .entry(record.emoji)
                .or_default()
                .push(record.user_id);
        }
    }

    reactions
}
