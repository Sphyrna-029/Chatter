use super::super::{
    helpers::{do_join_room, error_response, extract_token, get_user_from_token, now_millis},
    state::{AppState, InviteRecord, RoomRecord},
};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::Json,
};
use futures_util::TryStreamExt;
use mongodb::bson::doc;
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
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let rooms_coll = state.db.collection::<RoomRecord>("rooms");
    let room = rooms_coll
        .find_one(doc! { "_id": &room_id })
        .await
        .ok()
        .flatten()
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

    let code = generate_invite_code();
    let record = InviteRecord {
        code: code.clone(),
        room_id: room_id.clone(),
        creator: user_id,
        click_count: 0,
        created_at: now_millis(),
    };

    let inv_coll = state.db.collection::<InviteRecord>("invites");
    let _ = inv_coll.insert_one(record).await;

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
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let rooms_coll = state.db.collection::<RoomRecord>("rooms");
    let room = rooms_coll
        .find_one(doc! { "_id": &room_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Room not found"))?;

    if room.creator != user_id {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "Only the room owner can list invites",
        ));
    }

    let inv_coll = state.db.collection::<InviteRecord>("invites");
    let mut list: Vec<Value> = Vec::new();

    if let Ok(mut cursor) = inv_coll.find(doc! { "room_id": &room_id }).await {
        while let Ok(Some(inv)) = cursor.try_next().await {
            list.push(json!({
                "code": inv.code,
                "click_count": inv.click_count,
                "created_at": inv.created_at,
            }));
        }
    }

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
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let inv_coll = state.db.collection::<InviteRecord>("invites");
    let invite = inv_coll
        .find_one(doc! { "_id": &code })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Invite not found"))?;

    let rooms_coll = state.db.collection::<RoomRecord>("rooms");
    let room = rooms_coll
        .find_one(doc! { "_id": &invite.room_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Room not found"))?;

    if room.creator != user_id {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "Only the room owner can delete invites",
        ));
    }

    let _ = inv_coll.delete_one(doc! { "_id": &code }).await;

    Ok(Json(json!({ "success": true })))
}

pub(crate) async fn get_invite_info(
    State(state): State<Arc<AppState>>,
    Path(code): Path<String>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let inv_coll = state.db.collection::<InviteRecord>("invites");

    // Increment click count
    let invite = inv_coll
        .find_one_and_update(
            doc! { "_id": &code },
            doc! { "$inc": { "click_count": 1_i64 } },
        )
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Invite not found"))?;

    let rooms_coll = state.db.collection::<RoomRecord>("rooms");
    let room = rooms_coll
        .find_one(doc! { "_id": &invite.room_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Room not found"))?;

    let rm = state.room_members.read().await;
    let member_count = rm.get(&invite.room_id).map(|m| m.len()).unwrap_or(0);

    Ok(Json(json!({
        "room_name": room.name,
        "icon_url": room.icon_url,
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
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let inv_coll = state.db.collection::<InviteRecord>("invites");
    let invite = inv_coll
        .find_one(doc! { "_id": &code })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Invite not found"))?;

    let rooms_coll = state.db.collection::<RoomRecord>("rooms");
    if rooms_coll
        .find_one(doc! { "_id": &invite.room_id })
        .await
        .ok()
        .flatten()
        .is_none()
    {
        return Err(error_response(StatusCode::NOT_FOUND, "Room no longer exists"));
    }

    do_join_room(&state, &invite.room_id, &user_id).await;

    Ok(Json(json!({ "room_id": invite.room_id })))
}
