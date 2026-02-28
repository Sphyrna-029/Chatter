use super::super::{
    dto::{CreateWebhookRequest, WebhookMessageRequest},
    helpers::{broadcast_to_room, error_response, extract_token, generate_id, get_user_from_token, now_millis},
    state::{AppState, RoomRecord, WebhookRecord},
};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::Json,
};
use futures_util::TryStreamExt;
use mongodb::bson::doc;
use serde_json::{json, Value};
use std::sync::Arc;

pub(crate) async fn create_webhook(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<CreateWebhookRequest>,
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
            "Only the room owner can create webhooks",
        ));
    }

    let name = body.name.trim().to_string();
    if name.is_empty() || name.len() > 64 {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "Webhook name must be 1-64 characters",
        ));
    }

    let webhook_id = generate_id("whk");
    let record = WebhookRecord {
        webhook_id: webhook_id.clone(),
        room_id: room_id.clone(),
        creator: user_id,
        name,
        avatar_url: body.avatar_url.unwrap_or_default(),
        created_at: now_millis(),
    };

    let coll = state.db.collection::<WebhookRecord>("webhooks");
    let _ = coll.insert_one(record).await;

    Ok(Json(json!({
        "webhook_id": webhook_id,
        "url": format!("/api/webhooks/{}", webhook_id),
    })))
}

pub(crate) async fn list_webhooks(
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
            "Only the room owner can list webhooks",
        ));
    }

    let coll = state.db.collection::<WebhookRecord>("webhooks");
    let mut list: Vec<Value> = Vec::new();

    if let Ok(mut cursor) = coll.find(doc! { "room_id": &room_id }).await {
        while let Ok(Some(wh)) = cursor.try_next().await {
            list.push(json!({
                "webhook_id": wh.webhook_id,
                "name": wh.name,
                "avatar_url": wh.avatar_url,
                "created_at": wh.created_at,
                "url": format!("/api/webhooks/{}", wh.webhook_id),
            }));
        }
    }

    Ok(Json(json!({ "webhooks": list })))
}

pub(crate) async fn delete_webhook(
    State(state): State<Arc<AppState>>,
    Path(webhook_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let coll = state.db.collection::<WebhookRecord>("webhooks");
    let webhook = coll
        .find_one(doc! { "_id": &webhook_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Webhook not found"))?;

    let rooms_coll = state.db.collection::<RoomRecord>("rooms");
    let room = rooms_coll
        .find_one(doc! { "_id": &webhook.room_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Room not found"))?;

    if room.creator != user_id {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "Only the room owner can delete webhooks",
        ));
    }

    let _ = coll.delete_one(doc! { "_id": &webhook_id }).await;

    Ok(Json(json!({ "success": true })))
}

pub(crate) async fn execute_webhook(
    State(state): State<Arc<AppState>>,
    Path(webhook_id): Path<String>,
    Json(body): Json<WebhookMessageRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let text = body
        .content
        .or(body.text)
        .unwrap_or_default();
    let text = text.trim().to_string();

    if text.is_empty() {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "Message content is required",
        ));
    }
    if text.len() > 4000 {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "Message too long (max 4000 characters)",
        ));
    }

    let coll = state.db.collection::<WebhookRecord>("webhooks");
    let webhook = coll
        .find_one(doc! { "_id": &webhook_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Webhook not found"))?;

    let event_id = generate_id("$");
    let ts = now_millis();
    let sender = format!("webhook:{}", webhook_id);

    let event = json!({
        "type": "m.room.message",
        "room_id": webhook.room_id,
        "sender": sender,
        "content": {
            "msgtype": "m.text",
            "body": text,
            "webhook": true,
            "webhook_name": webhook.name,
            "webhook_avatar_url": webhook.avatar_url,
        },
        "event_id": event_id,
        "origin_server_ts": ts,
    });

    // Store in MongoDB
    let msg_coll = state.db.collection::<mongodb::bson::Document>("messages");
    if let Ok(doc) = mongodb::bson::to_document(&event) {
        let _ = msg_coll.insert_one(doc).await;
    }

    broadcast_to_room(&state, &webhook.room_id, &event).await;

    Ok(Json(json!({ "event_id": event_id })))
}
