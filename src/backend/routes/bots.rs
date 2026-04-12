use super::super::{
    dto::CreateBotRequest,
    helpers::{error_response, extract_token, generate_id, get_user_from_token, now_millis},
    state::{AppState, BotRecord, ChannelRecord, RoomRecord},
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
use sha2::{Digest, Sha256};
use std::sync::Arc;

fn generate_bot_token() -> String {
    let bytes: [u8; 32] = rand::thread_rng().gen();
    hex::encode(bytes)
}

pub(crate) fn hash_bot_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hex::encode(hasher.finalize())
}

pub(crate) async fn create_bot(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<CreateBotRequest>,
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
            "Only the room owner can create bots",
        ));
    }

    let name = body.name.trim().to_string();
    if name.is_empty() || name.len() > 64 {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "Bot name must be 1-64 characters",
        ));
    }

    let bot_id = generate_id("bot");
    let raw_token = generate_bot_token();
    let token_hash = hash_bot_token(&raw_token);

    let record = BotRecord {
        bot_id: bot_id.clone(),
        room_id: room_id.clone(),
        name,
        avatar_url: body.avatar_url.unwrap_or_default(),
        description: body.description.unwrap_or_default(),
        token_hash,
        created_by: user_id,
        created_at: now_millis(),
    };

    let coll = state.db.collection::<BotRecord>("bots");
    let _ = coll.insert_one(record).await;

    Ok(Json(json!({
        "bot_id": bot_id,
        "token": raw_token,
    })))
}

pub(crate) async fn list_bots(
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
            "Only the room owner can list bots",
        ));
    }

    let coll = state.db.collection::<BotRecord>("bots");
    let mut list: Vec<Value> = Vec::new();

    if let Ok(mut cursor) = coll.find(doc! { "room_id": &room_id }).await {
        while let Ok(Some(bot)) = cursor.try_next().await {
            list.push(json!({
                "bot_id": bot.bot_id,
                "name": bot.name,
                "avatar_url": bot.avatar_url,
                "description": bot.description,
                "created_at": bot.created_at,
            }));
        }
    }

    Ok(Json(json!({ "bots": list })))
}

pub(crate) async fn delete_bot(
    State(state): State<Arc<AppState>>,
    Path(bot_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let coll = state.db.collection::<BotRecord>("bots");
    let bot = coll
        .find_one(doc! { "_id": &bot_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Bot not found"))?;

    let rooms_coll = state.db.collection::<RoomRecord>("rooms");
    let room = rooms_coll
        .find_one(doc! { "_id": &bot.room_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Room not found"))?;

    if room.creator != user_id {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "Only the room owner can delete bots",
        ));
    }

    // Delete bot's channels
    let channels_coll = state.db.collection::<ChannelRecord>("channels");
    let _ = channels_coll.delete_many(doc! { "bot_id": &bot_id }).await;

    // Delete the bot
    let _ = coll.delete_one(doc! { "_id": &bot_id }).await;

    Ok(Json(json!({ "success": true })))
}

pub(crate) async fn regenerate_bot_token(
    State(state): State<Arc<AppState>>,
    Path(bot_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let coll = state.db.collection::<BotRecord>("bots");
    let bot = coll
        .find_one(doc! { "_id": &bot_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Bot not found"))?;

    let rooms_coll = state.db.collection::<RoomRecord>("rooms");
    let room = rooms_coll
        .find_one(doc! { "_id": &bot.room_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Room not found"))?;

    if room.creator != user_id {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "Only the room owner can regenerate bot tokens",
        ));
    }

    let raw_token = generate_bot_token();
    let token_hash = hash_bot_token(&raw_token);

    let _ = coll
        .update_one(
            doc! { "_id": &bot_id },
            doc! { "$set": { "token_hash": &token_hash } },
        )
        .await;

    Ok(Json(json!({ "token": raw_token })))
}
