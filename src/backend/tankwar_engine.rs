use crate::backend::{
    helpers::broadcast_to_room,
    state::{AppState, Bullet, TankGameRecord, TankPlayer},
};
use mlua::prelude::*;
use mongodb::bson::doc;
use rand::Rng;
use serde_json::json;
use std::{collections::HashMap, sync::Arc};

const GRID_SIZE: usize = 64;
const TICK_DELAY_MS: u64 = 166; // ~6 ticks/sec
const KOTH_WIN_TICKS: u32 = 20;

// ─── Maze Generation (randomized DFS) ────────────────────────────────────────

pub(crate) fn generate_maze(size: usize) -> Vec<Vec<u8>> {
    // Open arena with scattered square blocks as cover
    let mut grid = vec![vec![0u8; size]; size];
    let mut rng = rand::thread_rng();

    // Border walls
    for i in 0..size {
        grid[0][i] = 1;
        grid[size - 1][i] = 1;
        grid[i][0] = 1;
        grid[i][size - 1] = 1;
    }

    // Place 10-14 random square blocks (2x2 to 5x5)
    let num_blocks = rng.gen_range(10..=14);
    let block_sizes = [2, 2, 3, 3, 3, 4, 4, 5];
    for _ in 0..num_blocks {
        let bs = block_sizes[rng.gen_range(0..block_sizes.len())];
        let bx = rng.gen_range(2..size - bs - 1);
        let by = rng.gen_range(2..size - bs - 1);
        for dy in 0..bs {
            for dx in 0..bs {
                grid[by + dy][bx + dx] = 1;
            }
        }
    }

    // Clear spawn corners (5x5 each)
    let corners = [(1, 1), (1, size - 6), (size - 6, 1), (size - 6, size - 6)];
    for &(sx, sy) in &corners {
        for dy in 0..5 {
            for dx in 0..5 {
                let nx = sx + dx;
                let ny = sy + dy;
                if nx < size - 1 && ny < size - 1 {
                    grid[ny][nx] = 0;
                }
            }
        }
    }

    // Clear center 5x5 area for flag
    let center = size / 2;
    for dy in 0..5 {
        for dx in 0..5 {
            let fx = center - 2 + dx;
            let fy = center - 2 + dy;
            if fx > 0 && fy > 0 && fx < size - 1 && fy < size - 1 {
                grid[fy][fx] = 0;
            }
        }
    }

    grid
}

// ─── Lua Sandbox ─────────────────────────────────────────────────────────────

struct PlayerAction {
    move_dir: Option<String>,
    shoot_dir: Option<String>,
}

fn run_player_lua(
    player: &TankPlayer,
    maze: &[Vec<u8>],
    flag_pos: [usize; 2],
    tick: usize,
    all_players: &[TankPlayer],
    storage: &HashMap<String, String>,
    game_mode: &str,
) -> (PlayerAction, HashMap<String, String>) {
    let lua = Lua::new();

    // Remove dangerous globals
    let globals = lua.globals();
    for name in &["os", "io", "debug", "dofile", "loadfile", "require", "load", "rawget", "rawset"] {
        let _ = globals.set(*name, LuaValue::Nil);
    }

    // Set instruction limit (10ms equivalent ~100k instructions)
    lua.set_hook(LuaHookTriggers::new().every_nth_instruction(100_000), |_lua, _debug| {
        Err(LuaError::runtime("Script execution limit exceeded"))
    });

    let action = Arc::new(std::sync::Mutex::new(PlayerAction {
        move_dir: None,
        shoot_dir: None,
    }));

    let new_storage = Arc::new(std::sync::Mutex::new(storage.clone()));

    // Register API functions
    {
        let action_clone = action.clone();
        let move_fn = lua.create_function(move |_, dir: String| {
            if matches!(dir.as_str(), "north" | "south" | "east" | "west") {
                if let Ok(mut a) = action_clone.lock() {
                    a.move_dir = Some(dir);
                }
            }
            Ok(())
        });
        if let Ok(f) = move_fn {
            let _ = globals.set("move", f);
        }
    }

    {
        let action_clone = action.clone();
        let shoot_fn = lua.create_function(move |_, dir: String| {
            if matches!(dir.as_str(), "north" | "south" | "east" | "west") {
                if let Ok(mut a) = action_clone.lock() {
                    a.shoot_dir = Some(dir);
                }
            }
            Ok(())
        });
        if let Ok(f) = shoot_fn {
            let _ = globals.set("shoot", f);
        }
    }

    // scan(dir, range) -> returns first thing found
    {
        let px = player.x;
        let py = player.y;
        let maze_clone: Vec<Vec<u8>> = maze.to_vec();
        let flag_clone = flag_pos;
        let enemies: Vec<(usize, usize)> = all_players
            .iter()
            .filter(|p| p.user_id != player.user_id && p.alive)
            .map(|p| (p.x, p.y))
            .collect();

        let scan_fn = lua.create_function(move |_, (dir, range): (String, usize)| {
            let (dx, dy): (i32, i32) = match dir.as_str() {
                "north" => (0, -1),
                "south" => (0, 1),
                "east" => (1, 0),
                "west" => (-1, 0),
                _ => return Ok("empty".to_string()),
            };
            let mut cx = px as i32;
            let mut cy = py as i32;
            for _ in 0..range {
                cx += dx;
                cy += dy;
                if cx < 0 || cy < 0 || cx >= GRID_SIZE as i32 || cy >= GRID_SIZE as i32 {
                    return Ok("wall".to_string());
                }
                let ux = cx as usize;
                let uy = cy as usize;
                if maze_clone[uy][ux] == 1 {
                    return Ok("wall".to_string());
                }
                if ux == flag_clone[0] && uy == flag_clone[1] {
                    return Ok("flag".to_string());
                }
                for &(ex, ey) in &enemies {
                    if ux == ex && uy == ey {
                        return Ok("enemy".to_string());
                    }
                }
            }
            Ok("empty".to_string())
        });
        if let Ok(f) = scan_fn {
            let _ = globals.set("scan", f);
        }
    }

    // get_position()
    {
        let px = player.x;
        let py = player.y;
        let pos_fn = lua.create_function(move |lua, ()| {
            let table = lua.create_table()?;
            table.set("x", px)?;
            table.set("y", py)?;
            Ok(table)
        });
        if let Ok(f) = pos_fn {
            let _ = globals.set("get_position", f);
        }
    }

    // get_health()
    {
        let hp = player.health;
        let health_fn = lua.create_function(move |_, ()| Ok(hp));
        if let Ok(f) = health_fn {
            let _ = globals.set("get_health", f);
        }
    }

    // get_flag_position()
    {
        let fp = flag_pos;
        let flag_fn = lua.create_function(move |lua, ()| {
            let table = lua.create_table()?;
            table.set("x", fp[0])?;
            table.set("y", fp[1])?;
            Ok(table)
        });
        if let Ok(f) = flag_fn {
            let _ = globals.set("get_flag_position", f);
        }
    }

    // get_tick()
    {
        let t = tick;
        let tick_fn = lua.create_function(move |_, ()| Ok(t));
        if let Ok(f) = tick_fn {
            let _ = globals.set("get_tick", f);
        }
    }

    // get_game_mode()
    {
        let mode = game_mode.to_string();
        let mode_fn = lua.create_function(move |_, ()| Ok(mode.clone()));
        if let Ok(f) = mode_fn {
            let _ = globals.set("get_game_mode", f);
        }
    }

    // store(key, val)
    {
        let ns = new_storage.clone();
        let store_fn = lua.create_function(move |_, (key, val): (String, String)| {
            if let Ok(mut s) = ns.lock() {
                if s.len() < 100 {
                    s.insert(key, val);
                }
            }
            Ok(())
        });
        if let Ok(f) = store_fn {
            let _ = globals.set("store", f);
        }
    }

    // recall(key)
    {
        let ns = new_storage.clone();
        let recall_fn = lua.create_function(move |_, key: String| {
            let val = ns.lock().ok().and_then(|s| s.get(&key).cloned());
            Ok(val)
        });
        if let Ok(f) = recall_fn {
            let _ = globals.set("recall", f);
        }
    }

    // Execute the player's script
    let _ = lua.load(&player.script).exec();

    let final_action = action.lock().map(|a| PlayerAction {
        move_dir: a.move_dir.clone(),
        shoot_dir: a.shoot_dir.clone(),
    }).unwrap_or(PlayerAction { move_dir: None, shoot_dir: None });

    let final_storage = new_storage.lock().map(|s| s.clone()).unwrap_or_default();

    (final_action, final_storage)
}

// ─── Game Loop ───────────────────────────────────────────────────────────────

pub(crate) async fn run_tank_game(state: Arc<AppState>, room_id: String, game_id: String) {
    let coll = state.db.collection::<TankGameRecord>("tank_games");

    // Load game from DB
    let mut game = match coll.find_one(doc! { "_id": &game_id }).await {
        Ok(Some(g)) => g,
        _ => return,
    };

    // Generate maze
    let maze = generate_maze(GRID_SIZE);

    // Place tanks at corners
    let spawn_positions = [
        (1usize, 1usize, "east"),
        (GRID_SIZE - 2, 1, "west"),
        (1, GRID_SIZE - 2, "east"),
        (GRID_SIZE - 2, GRID_SIZE - 2, "west"),
    ];

    let is_br = game.game_mode == "battle_royale";
    let is_koth = game.game_mode == "koth";
    let starting_health: u8 = if is_br { 1 } else { 3 };

    for (i, player) in game.players.iter_mut().enumerate() {
        let (x, y, dir) = spawn_positions[i % 4];
        player.x = x;
        player.y = y;
        player.direction = dir.to_string();
        player.health = starting_health;
        player.alive = true;
        player.hill_ticks = 0;
    }

    game.maze = maze;
    game.status = "running".to_string();
    game.flag_position = [GRID_SIZE / 2, GRID_SIZE / 2];
    game.bullets = Vec::new();

    // Save initial state
    let _ = coll
        .replace_one(doc! { "_id": &game_id }, &game)
        .await;

    // Broadcast game start
    let start_event = json!({
        "type": "tankwar_game_start",
        "room_id": &room_id,
        "game_id": &game_id,
        "grid_size": GRID_SIZE,
        "maze": &game.maze,
        "flag_position": &game.flag_position,
        "game_mode": &game.game_mode,
        "players": game.players.iter().map(|p| json!({
            "user_id": p.user_id,
            "x": p.x,
            "y": p.y,
            "direction": p.direction,
            "health": p.health,
            "alive": p.alive,
            "color": p.color,
            "score": p.score,
        })).collect::<Vec<_>>(),
    });
    broadcast_to_room(&state, &room_id, &start_event).await;

    // Per-player persistent storage across ticks
    let mut player_storage: HashMap<String, HashMap<String, String>> = HashMap::new();
    for p in &game.players {
        player_storage.insert(p.user_id.clone(), HashMap::new());
    }

    let max_ticks = game.max_ticks;

    // Game loop
    for tick in 0..max_ticks {
        game.current_tick = tick;

        // Run each alive player's script
        let mut actions: Vec<(String, PlayerAction)> = Vec::new();
        let players_snapshot = game.players.clone();

        for player in &game.players {
            if !player.alive || player.script.is_empty() {
                continue;
            }

            let storage = player_storage
                .get(&player.user_id)
                .cloned()
                .unwrap_or_default();

            let (action, new_storage) = tokio::task::spawn_blocking({
                let player = player.clone();
                let maze = game.maze.clone();
                let flag_pos = game.flag_position;
                let all_players = players_snapshot.clone();
                let mode = game.game_mode.clone();
                move || run_player_lua(&player, &maze, flag_pos, tick, &all_players, &storage, &mode)
            })
            .await
            .unwrap_or_else(|_| {
                (
                    PlayerAction {
                        move_dir: None,
                        shoot_dir: None,
                    },
                    HashMap::new(),
                )
            });

            player_storage.insert(player.user_id.clone(), new_storage);
            actions.push((player.user_id.clone(), action));
        }

        // Resolve movements
        for (uid, action) in &actions {
            if let Some(ref dir) = action.move_dir {
                let idx = game.players.iter().position(|p| p.user_id == *uid);
                if let Some(pi) = idx {
                    let (dx, dy): (i32, i32) = match dir.as_str() {
                        "north" => (0, -1),
                        "south" => (0, 1),
                        "east" => (1, 0),
                        "west" => (-1, 0),
                        _ => continue,
                    };
                    let nx = game.players[pi].x as i32 + dx;
                    let ny = game.players[pi].y as i32 + dy;
                    if nx >= 0
                        && ny >= 0
                        && (nx as usize) < GRID_SIZE
                        && (ny as usize) < GRID_SIZE
                        && game.maze[ny as usize][nx as usize] == 0
                    {
                        let occupied = game
                            .players
                            .iter()
                            .enumerate()
                            .any(|(i, p)| i != pi && p.alive && p.x == nx as usize && p.y == ny as usize);
                        if !occupied {
                            game.players[pi].x = nx as usize;
                            game.players[pi].y = ny as usize;
                            game.players[pi].direction = dir.clone();
                        }
                    }
                }
            }
        }

        // Spawn new bullets
        for (uid, action) in &actions {
            if let Some(ref dir) = action.shoot_dir {
                if let Some(player) = game.players.iter().find(|p| p.user_id == *uid && p.alive) {
                    let (dx, dy): (i32, i32) = match dir.as_str() {
                        "north" => (0, -1),
                        "south" => (0, 1),
                        "east" => (1, 0),
                        "west" => (-1, 0),
                        _ => continue,
                    };
                    let bx = player.x as i32 + dx;
                    let by = player.y as i32 + dy;
                    if bx >= 0
                        && by >= 0
                        && (bx as usize) < GRID_SIZE
                        && (by as usize) < GRID_SIZE
                        && game.maze[by as usize][bx as usize] == 0
                    {
                        game.bullets.push(Bullet {
                            x: bx as usize,
                            y: by as usize,
                            direction: dir.clone(),
                            owner: uid.clone(),
                        });
                    }
                }
            }
        }

        // Move existing bullets
        let mut remaining_bullets = Vec::new();
        for mut bullet in game.bullets.drain(..) {
            let (dx, dy): (i32, i32) = match bullet.direction.as_str() {
                "north" => (0, -1),
                "south" => (0, 1),
                "east" => (1, 0),
                "west" => (-1, 0),
                _ => continue,
            };
            let nx = bullet.x as i32 + dx;
            let ny = bullet.y as i32 + dy;
            if nx < 0 || ny < 0 || nx as usize >= GRID_SIZE || ny as usize >= GRID_SIZE {
                continue; // out of bounds
            }
            let ux = nx as usize;
            let uy = ny as usize;
            if game.maze[uy][ux] == 1 {
                continue; // hit wall
            }
            bullet.x = ux;
            bullet.y = uy;

            // Check hit on players
            let mut hit = false;
            let hit_idx = game.players.iter().position(|p| {
                p.alive && p.user_id != bullet.owner && p.x == ux && p.y == uy
            });
            if let Some(hi) = hit_idx {
                game.players[hi].health = game.players[hi].health.saturating_sub(1);
                if game.players[hi].health == 0 {
                    game.players[hi].alive = false;
                }
                // Award score to shooter
                if let Some(si) = game.players.iter().position(|p| p.user_id == bullet.owner) {
                    game.players[si].score += 10;
                }
                hit = true;
            }
            if !hit {
                remaining_bullets.push(bullet);
            }
        }
        game.bullets = remaining_bullets;

        // ─── Mode-based win conditions ─────────────────────────────────────
        let mut winner: Option<String> = None;

        if is_koth {
            // KOTH: track hill occupancy (3x3 area around flag_position)
            let hx = game.flag_position[0];
            let hy = game.flag_position[1];
            for player in game.players.iter_mut() {
                if !player.alive {
                    continue;
                }
                let dx = (player.x as i32 - hx as i32).unsigned_abs() as usize;
                let dy = (player.y as i32 - hy as i32).unsigned_abs() as usize;
                if dx <= 1 && dy <= 1 {
                    player.hill_ticks += 1;
                    if player.hill_ticks >= KOTH_WIN_TICKS {
                        winner = Some(player.user_id.clone());
                    }
                } else {
                    player.hill_ticks = 0;
                }
            }
        } else if !is_br {
            // CTF: check flag capture
            for player in &game.players {
                if player.alive
                    && player.x == game.flag_position[0]
                    && player.y == game.flag_position[1]
                {
                    winner = Some(player.user_id.clone());
                    break;
                }
            }
        }
        // Battle Royale: no flag, no hill — only last-alive wins

        // All modes: last player alive wins, all dead = tie
        if winner.is_none() && game.players.len() > 1 {
            let alive_players: Vec<&TankPlayer> =
                game.players.iter().filter(|p| p.alive).collect();
            if alive_players.len() == 1 {
                winner = Some(alive_players[0].user_id.clone());
            } else if alive_players.is_empty() {
                // All dead — end as tie (winner stays None)
                game.status = "finished".to_string();
                game.winner = None;

                let game_over_event = json!({
                    "type": "tankwar_game_over",
                    "room_id": &room_id,
                    "game_id": &game_id,
                    "winner": null,
                    "players": game.players.iter().map(|p| json!({
                        "user_id": p.user_id,
                        "score": p.score,
                        "alive": p.alive,
                        "health": p.health,
                    })).collect::<Vec<_>>(),
                });
                broadcast_to_room(&state, &room_id, &game_over_event).await;

                let _ = coll.replace_one(doc! { "_id": &game_id }, &game).await;
                state.tank_games.write().await.remove(&game_id);
                return;
            }
        }

        // Broadcast tick
        let tick_event = json!({
            "type": "tankwar_tick",
            "room_id": &room_id,
            "game_id": &game_id,
            "tick": tick,
            "players": game.players.iter().map(|p| json!({
                "user_id": p.user_id,
                "x": p.x,
                "y": p.y,
                "direction": p.direction,
                "health": p.health,
                "alive": p.alive,
                "score": p.score,
                "hill_ticks": p.hill_ticks,
            })).collect::<Vec<_>>(),
            "bullets": game.bullets.iter().map(|b| json!({
                "x": b.x,
                "y": b.y,
                "direction": b.direction,
                "owner": b.owner,
            })).collect::<Vec<_>>(),
        });
        broadcast_to_room(&state, &room_id, &tick_event).await;

        if let Some(ref w) = winner {
            game.winner = Some(w.clone());
            game.status = "finished".to_string();

            let game_over_event = json!({
                "type": "tankwar_game_over",
                "room_id": &room_id,
                "game_id": &game_id,
                "winner": w,
                "players": game.players.iter().map(|p| json!({
                    "user_id": p.user_id,
                    "score": p.score,
                    "alive": p.alive,
                    "health": p.health,
                })).collect::<Vec<_>>(),
            });
            broadcast_to_room(&state, &room_id, &game_over_event).await;

            let _ = coll.replace_one(doc! { "_id": &game_id }, &game).await;

            // Remove from active games
            state.tank_games.write().await.remove(&game_id);
            return;
        }

        tokio::time::sleep(std::time::Duration::from_millis(TICK_DELAY_MS)).await;
    }

    // Game ended by tick limit
    game.status = "finished".to_string();
    let alive: Vec<&TankPlayer> = game.players.iter().filter(|p| p.alive).collect();
    game.winner = if alive.is_empty() {
        None
    } else if is_koth {
        let max_ht = alive.iter().map(|p| p.hill_ticks).max().unwrap_or(0);
        let top: Vec<&&TankPlayer> = alive.iter().filter(|p| p.hill_ticks == max_ht).collect();
        if top.len() == 1 { Some(top[0].user_id.clone()) } else { None }
    } else {
        let max_score = alive.iter().map(|p| p.score).max().unwrap_or(0);
        let top: Vec<&&TankPlayer> = alive.iter().filter(|p| p.score == max_score).collect();
        if top.len() == 1 { Some(top[0].user_id.clone()) } else { None }
    };

    let game_over_event = json!({
        "type": "tankwar_game_over",
        "room_id": &room_id,
        "game_id": &game_id,
        "winner": game.winner,
        "players": game.players.iter().map(|p| json!({
            "user_id": p.user_id,
            "score": p.score,
            "alive": p.alive,
            "health": p.health,
        })).collect::<Vec<_>>(),
    });
    broadcast_to_room(&state, &room_id, &game_over_event).await;

    let _ = coll.replace_one(doc! { "_id": &game_id }, &game).await;
    state.tank_games.write().await.remove(&game_id);
}
