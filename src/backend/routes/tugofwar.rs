use super::super::{
    helpers::{error_response, extract_token, generate_id, get_user_from_token, now_millis},
    state::{AppState, RoomRecord, TugOfWarGame, TugOfWarPlayer},
    tugofwar_engine::PROMPTS,
};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::Json,
};
use mongodb::bson::doc;
use rand::seq::SliceRandom;
use serde_json::{json, Value};
use std::sync::Arc;

async fn validate_tugofwar_member(
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

    if room.room_type != "tugofwar" {
        return Err(error_response(StatusCode::BAD_REQUEST, "Room is not a tug of war room"));
    }

    {
        let rm = state.room_members.read().await;
        if !rm.get(room_id).map(|m| m.contains(&user_id)).unwrap_or(false) {
            return Err(error_response(StatusCode::FORBIDDEN, "Not a member of this room"));
        }
    }

    Ok(user_id)
}

pub(crate) async fn get_tugofwar_state(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let _user_id = validate_tugofwar_member(&state, &headers, &room_id).await?;

    let coll = state.db.collection::<TugOfWarGame>("tug_of_war_games");
    if let Ok(Some(game)) = coll
        .find_one(doc! { "room_id": &room_id, "status": { "$ne": "finished" } })
        .await
    {
        return Ok(Json(json!({
            "game_id": game.game_id,
            "status": game.status,
            "players": game.players.iter().map(|p| json!({
                "user_id": p.user_id,
                "team": p.team,
                "ready": p.ready,
                "chars_correct": p.chars_correct,
                "errors": p.errors,
                "wps": p.wps,
            })).collect::<Vec<_>>(),
            "rope_position": game.rope_position,
            "prompt": game.prompt,
            "started_at": game.started_at,
            "winner": game.winner,
        })));
    }

    Ok(Json(json!({ "game_id": null, "status": "none" })))
}

pub(crate) async fn new_tugofwar_game(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let user_id = validate_tugofwar_member(&state, &headers, &room_id).await?;

    let coll = state.db.collection::<TugOfWarGame>("tug_of_war_games");

    // Finish any stale non-finished games
    let _ = coll
        .update_many(
            doc! { "room_id": &room_id, "status": { "$ne": "finished" } },
            doc! { "$set": { "status": "finished" } },
        )
        .await;

    // Abort active tick tasks for this room
    {
        let mut tg = state.tug_of_war_games.write().await;
        for handle in tg.values() {
            handle.abort();
        }
        tg.clear();
    }

    let prompt = PROMPTS
        .choose(&mut rand::thread_rng())
        .copied()
        .unwrap_or(PROMPTS[0])
        .to_string();

    let game_id = generate_id("tow_");
    let game = TugOfWarGame {
        game_id: game_id.clone(),
        room_id: room_id.clone(),
        status: "lobby".to_string(),
        players: vec![TugOfWarPlayer {
            user_id: user_id.clone(),
            team: String::new(),
            ready: false,
            chars_correct: 0,
            errors: 0,
            wps: 0.0,
        }],
        rope_position: 0.0,
        prompt,
        started_at: None,
        winner: None,
        reset_votes: Vec::new(),
        created_at: now_millis(),
    };

    coll.insert_one(&game)
        .await
        .map_err(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "Failed to create game"))?;

    Ok(Json(json!({ "game_id": game_id })))
}
