use crate::backend::{
    helpers::{broadcast_to_room, now_millis},
    state::{AppState, TugOfWarGame},
};
use mongodb::bson::doc;
use serde_json::json;
use std::sync::Arc;

pub(crate) const PROMPTS: &[&str] = &[
    "the quick brown fox jumps over the lazy dog",
    "pack my box with five dozen liquor jugs",
    "how vexingly quick daft zebras jump across the canyon",
    "the five boxing wizards jump quickly over the fence",
    "sphinx of black quartz judge my vow before the sunrise",
    "two driven jocks help fax my big quiz to the editor",
    "the wizard quickly jinxed the gnomes before they vaporized",
    "sixty zippers were quickly picked from the woven jute bag",
    "a competent programmer writes clean code that solves real problems",
    "fast and accurate typing gives your team the winning advantage",
    "practice makes perfect and precision beats raw speed every time",
    "keep your eyes on the screen and your fingers on the home row",
    "consistency and focus will carry your team to a decisive victory",
    "every correct character brings your team one step closer to glory",
    "the path to mastery is paved with deliberate and focused repetition",
];

const ROPE_WIN_THRESHOLD: f64 = 50.0;
const ROPE_SCALE: f64 = 15.0; // WPS difference → rope units/sec
const TICK_INTERVAL_MS: u64 = 500;
const MAX_GAME_DURATION_MS: i64 = 120_000; // 2 minutes

pub(crate) async fn run_tug_of_war_game(
    state: Arc<AppState>,
    room_id: String,
    game_id: String,
) {
    let tick_duration = tokio::time::Duration::from_millis(TICK_INTERVAL_MS);
    let tick_secs = TICK_INTERVAL_MS as f64 / 1000.0;

    loop {
        tokio::time::sleep(tick_duration).await;

        let coll = state.db.collection::<TugOfWarGame>("tug_of_war_games");
        let game = match coll.find_one(doc! { "_id": &game_id }).await {
            Ok(Some(g)) => g,
            _ => break,
        };

        if game.status != "running" {
            break;
        }

        let started_at = match game.started_at {
            Some(t) => t,
            None => break,
        };

        let now = now_millis();
        let elapsed_secs = (now - started_at) as f64 / 1000.0;
        if elapsed_secs < 1.0 {
            continue; // skip first tick for accurate WPS
        }

        // Calculate WPS per player and team averages
        let mut updated_players = game.players.clone();
        let mut left_wps_sum = 0.0f64;
        let mut left_count = 0usize;
        let mut right_wps_sum = 0.0f64;
        let mut right_count = 0usize;

        for p in &mut updated_players {
            let wps = (p.chars_correct as f64 / 5.0) / elapsed_secs;
            p.wps = wps;
            match p.team.as_str() {
                "left" => {
                    left_wps_sum += wps;
                    left_count += 1;
                }
                "right" => {
                    right_wps_sum += wps;
                    right_count += 1;
                }
                _ => {}
            }
        }

        let left_avg = if left_count > 0 { left_wps_sum / left_count as f64 } else { 0.0 };
        let right_avg = if right_count > 0 { right_wps_sum / right_count as f64 } else { 0.0 };

        // Positive rope_position = right team winning (rope moved toward left = right pulls)
        // right_avg > left_avg → rope moves positive
        let rope_velocity = (right_avg - left_avg) * ROPE_SCALE;
        let new_rope = (game.rope_position + rope_velocity * tick_secs).clamp(-100.0, 100.0);

        let time_up = now - started_at >= MAX_GAME_DURATION_MS;

        let winner: Option<String> = if new_rope >= ROPE_WIN_THRESHOLD {
            Some("right".to_string())
        } else if new_rope <= -ROPE_WIN_THRESHOLD {
            Some("left".to_string())
        } else if time_up {
            if new_rope > 0.0 {
                Some("right".to_string())
            } else if new_rope < 0.0 {
                Some("left".to_string())
            } else {
                Some("draw".to_string())
            }
        } else {
            None
        };

        let finished = winner.is_some();
        let mut updated_game = game.clone();
        updated_game.rope_position = new_rope;
        updated_game.status = if finished { "finished" } else { "running" }.to_string();
        updated_game.players = updated_players.clone();
        if finished {
            updated_game.winner = winner.clone();
        }
        let _ = coll.replace_one(doc! { "_id": &game_id }, &updated_game).await;

        // Broadcast rope state every tick
        let event = json!({
            "type": "tugofwar_rope_update",
            "room_id": &room_id,
            "game_id": &game_id,
            "rope_position": new_rope,
            "left_wps": left_avg,
            "right_wps": right_avg,
            "players": updated_players.iter().map(|p| json!({
                "user_id": &p.user_id,
                "team": &p.team,
                "wps": p.wps,
                "chars_correct": p.chars_correct,
            })).collect::<Vec<_>>(),
        });
        broadcast_to_room(&state, &room_id, &event).await;

        if finished {
            let game_over = json!({
                "type": "tugofwar_game_over",
                "room_id": &room_id,
                "game_id": &game_id,
                "winner": &winner,
            });
            broadcast_to_room(&state, &room_id, &game_over).await;
            break;
        }
    }

    state.tug_of_war_games.write().await.remove(&game_id);
}
