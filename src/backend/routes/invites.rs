use super::super::{
    helpers::{do_join_room, error_response, extract_token, get_user_from_token, now_millis},
    state::{AppState, InviteRecord},
};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::Json,
};
use rand::Rng;
use serde_json::{json, Value};
use std::sync::Arc;

fn generate_invite_code() -> String {
    const CHARSET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
    let mut rng = rand::thread_rng();
    (0..8)
        .map(|_| CHARSET[rng.gen_range(0..CHARSET.len())] as char)
        .collect()
}

pub(crate) async fn create_invite(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .await
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let rooms = state.rooms.read().await;
    let room = rooms
        .get(&room_id)
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Room not found"))?;
    if room.creator != user_id {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "Only the room owner can create invites",
        ));
    }
    if room.is_dm {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "Cannot create invites for DM rooms",
        ));
    }
    drop(rooms);

    let code = generate_invite_code();
    let record = InviteRecord {
        code: code.clone(),
        room_id: room_id.clone(),
        creator: user_id,
        click_count: 0,
        created_at: now_millis(),
    };
    state.invites.write().await.insert(code.clone(), record);

    Ok(Json(json!({ "code": code })))
}

pub(crate) async fn list_invites(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .await
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let rooms = state.rooms.read().await;
    let room = rooms
        .get(&room_id)
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Room not found"))?;
    if room.creator != user_id {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "Only the room owner can list invites",
        ));
    }
    drop(rooms);

    let invites = state.invites.read().await;
    let list: Vec<Value> = invites
        .values()
        .filter(|inv| inv.room_id == room_id)
        .map(|inv| {
            json!({
                "code": inv.code,
                "click_count": inv.click_count,
                "created_at": inv.created_at,
            })
        })
        .collect();

    Ok(Json(json!({ "invites": list })))
}

pub(crate) async fn delete_invite(
    State(state): State<Arc<AppState>>,
    Path(code): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .await
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let invites = state.invites.read().await;
    let invite = invites
        .get(&code)
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Invite not found"))?;
    let room_id = invite.room_id.clone();
    drop(invites);

    let rooms = state.rooms.read().await;
    let room = rooms
        .get(&room_id)
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Room not found"))?;
    if room.creator != user_id {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "Only the room owner can delete invites",
        ));
    }
    drop(rooms);

    state.invites.write().await.remove(&code);

    Ok(Json(json!({ "success": true })))
}

pub(crate) async fn get_invite_info(
    State(state): State<Arc<AppState>>,
    Path(code): Path<String>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    // Increment click count
    let mut invites = state.invites.write().await;
    let invite = invites
        .get_mut(&code)
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Invite not found"))?;
    invite.click_count += 1;
    let room_id = invite.room_id.clone();
    drop(invites);

    let rooms = state.rooms.read().await;
    let room = rooms
        .get(&room_id)
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Room not found"))?;
    let name = room.name.clone();
    let icon_url = room.icon_url.clone();
    drop(rooms);

    let rm = state.room_members.read().await;
    let member_count = rm.get(&room_id).map(|m| m.len()).unwrap_or(0);

    Ok(Json(json!({
        "room_name": name,
        "icon_url": icon_url,
        "member_count": member_count,
    })))
}

pub(crate) async fn accept_invite(
    State(state): State<Arc<AppState>>,
    Path(code): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .await
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let invites = state.invites.read().await;
    let invite = invites
        .get(&code)
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Invite not found"))?;
    let room_id = invite.room_id.clone();
    drop(invites);

    if !state.rooms.read().await.contains_key(&room_id) {
        return Err(error_response(StatusCode::NOT_FOUND, "Room no longer exists"));
    }

    do_join_room(&state, &room_id, &user_id).await;

    Ok(Json(json!({ "room_id": room_id })))
}
