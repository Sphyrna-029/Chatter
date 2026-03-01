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
                    "hill_ticks": p.hill_ticks,
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
            "game_mode": game.game_mode,
        })));
    }

    Ok(Json(json!({ "game_id": null, "status": "none" })))
}

pub(crate) async fn new_tankwar_game(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
    body: Option<Json<Value>>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let user_id = validate_tankwar_member(&state, &headers, &room_id).await?;

    let body_val = body.map(|b| b.0);
    let game_mode = body_val
        .as_ref()
        .and_then(|b| b.get("game_mode"))
        .and_then(|v| v.as_str())
        .filter(|m| matches!(*m, "ctf" | "battle_royale" | "koth"))
        .unwrap_or("ctf")
        .to_string();
    let max_ticks = body_val
        .as_ref()
        .and_then(|b| b.get("max_ticks"))
        .and_then(|v| v.as_u64())
        .map(|v| (v as usize).clamp(100, 10000))
        .unwrap_or(1000);
    let starting_health: u8 = if game_mode == "battle_royale" { 1 } else { 3 };

    let coll = state.db.collection::<TankGameRecord>("tank_games");

    // Force-finish any stale non-finished games (handles race after game_over/reset)
    let _ = coll
        .update_many(
            doc! { "room_id": &room_id, "status": { "$ne": "finished" } },
            doc! { "$set": { "status": "finished" } },
        )
        .await;

    // Abort any active game task handles for this room's games
    {
        let mut tg = state.tank_games.write().await;
        let stale_keys: Vec<String> = tg.keys().cloned().collect();
        for key in stale_keys {
            if let Some(handle) = tg.remove(&key) {
                handle.abort();
            }
        }
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
        health: starting_health,
        alive: true,
        color: colors[0].to_string(),
        score: 0,
        hill_ticks: 0,
    };

    let game = TankGameRecord {
        game_id: game_id.clone(),
        room_id: room_id.clone(),
        status: "lobby".to_string(),
        grid_size: 64,
        max_ticks,
        current_tick: 0,
        maze: Vec::new(),
        players: vec![player],
        bullets: Vec::new(),
        flag_position: [32, 32],
        winner: None,
        reset_votes: Vec::new(),
        game_mode,
        created_at: now_millis(),
    };

    coll.insert_one(&game)
        .await
        .map_err(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "Failed to create game"))?;

    Ok(Json(json!({ "game_id": game_id })))
}
