use super::super::{
    helpers::{error_response, extract_token, generate_id, get_user_from_token, now_millis},
    state::{AppState, RoomRecord, TankGameRecord, TankPlayer},
};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::Json,
};
use mongodb::bson::doc;
use serde_json::{json, Value};
use std::sync::Arc;

async fn validate_tankwar_member(
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

    if room.room_type != "tankwar" {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "Room is not a tankwar room",
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

pub(crate) async fn get_tankwar_state(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let _user_id = validate_tankwar_member(&state, &headers, &room_id).await?;

    let coll = state.db.collection::<TankGameRecord>("tank_games");
    if let Ok(Some(game)) = coll
        .find_one(doc! { "room_id": &room_id, "status": { "$ne": "finished" } })
        .await
    {
        let players: Vec<Value> = game
            .players
            .iter()
            .map(|p| {
                json!({
                    "user_id": p.user_id,
                    "ready": p.ready,
                    "x": p.x,
                    "y": p.y,
                    "direction": p.direction,
                    "health": p.health,
                    "alive": p.alive,
                    "color": p.color,
                    "score": p.score,
                    "has_script": !p.script.is_empty(),
                })
            })
            .collect();

        return Ok(Json(json!({
            "game_id": game.game_id,
            "status": game.status,
            "grid_size": game.grid_size,
            "max_ticks": game.max_ticks,
            "current_tick": game.current_tick,
            "maze": game.maze,
            "players": players,
            "bullets": game.bullets,
            "flag_position": game.flag_position,
            "winner": game.winner,
        })));
    }

    Ok(Json(json!({ "game_id": null, "status": "none" })))
}

pub(crate) async fn new_tankwar_game(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let user_id = validate_tankwar_member(&state, &headers, &room_id).await?;

    let coll = state.db.collection::<TankGameRecord>("tank_games");

    // Check no active game
    if let Ok(Some(_)) = coll
        .find_one(doc! { "room_id": &room_id, "status": { "$in": ["lobby", "running"] } })
        .await
    {
        return Err(error_response(
            StatusCode::CONFLICT,
            "A game is already active in this room",
        ));
    }

    let colors = ["#ef4444", "#3b82f6", "#22c55e", "#eab308"];
    let game_id = generate_id("tank_");
    let player = TankPlayer {
        user_id: user_id.clone(),
        script: String::new(),
        ready: false,
        x: 1,
        y: 1,
        direction: "east".to_string(),
        health: 3,
        alive: true,
        color: colors[0].to_string(),
        score: 0,
    };

    let game = TankGameRecord {
        game_id: game_id.clone(),
        room_id: room_id.clone(),
        status: "lobby".to_string(),
        grid_size: 64,
        max_ticks: 1000,
        current_tick: 0,
        maze: Vec::new(),
        players: vec![player],
        bullets: Vec::new(),
        flag_position: [32, 32],
        winner: None,
        reset_votes: Vec::new(),
        created_at: now_millis(),
    };

    coll.insert_one(&game)
        .await
        .map_err(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "Failed to create game"))?;

    Ok(Json(json!({ "game_id": game_id })))
}
