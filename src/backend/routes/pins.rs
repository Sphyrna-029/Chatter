use super::super::{
    dto::PinsQuery,
    helpers::{
        broadcast_to_room, can_manage_messages, error_response, extract_token,
        get_allowed_channel_ids, get_user_from_token, now_millis,
    },
    state::{AppState, PinRecord, RoomRecord},
};
use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::Json,
};
use futures_util::TryStreamExt;
use mongodb::bson::doc;
use serde_json::{json, Value};
use std::sync::Arc;

/// Discord caps a channel at 50 pins; the same ceiling keeps the pin panel
/// scannable and the list query cheap.
const MAX_PINS_PER_CHANNEL: u64 = 50;

/// GET /api/rooms/{room_id}/pins?channel_id=&limit=&offset=
///
/// Returns a page of the pinned messages of one channel (or of the room's
/// channel-less feed when `channel_id` is omitted), newest pin first.
pub(crate) async fn list_pins(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<PinsQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    require_membership(&state, &room_id, &user_id).await?;

    let channel_id = query.channel_id.unwrap_or_default();
    require_channel_access(&state, &room_id, &user_id, &channel_id).await?;

    let limit = query
        .limit
        .unwrap_or(25)
        .clamp(1, MAX_PINS_PER_CHANNEL as i64);
    let offset = query.offset.unwrap_or(0);

    let pins_coll = state.db.collection::<PinRecord>("pins");
    // One past the page tells us whether another page exists without a count.
    let mut cursor = pins_coll
        .find(doc! { "room_id": &room_id, "channel_id": &channel_id })
        .sort(doc! { "pinned_at": -1 })
        .skip(offset)
        .limit(limit + 1)
        .await
        .map_err(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "DB query failed"))?;

    let mut records: Vec<PinRecord> = Vec::new();
    while let Ok(Some(record)) = cursor.try_next().await {
        records.push(record);
    }

    let has_more = records.len() as i64 > limit;
    records.truncate(limit as usize);
    // Hydration drops pins whose message is gone, so the next page has to
    // resume from the records consumed, not from the rows returned.
    let next_offset = offset + records.len() as u64;

    let mut pins: Vec<Value> = Vec::new();
    for record in records {
        if let Some(message) = load_pinned_message(&state, &room_id, &record).await {
            pins.push(message);
        }
    }

    Ok(Json(json!({
        "pins": pins,
        "has_more": has_more,
        "next_offset": next_offset
    })))
}

/// POST /api/rooms/{room_id}/pins/{event_id}
pub(crate) async fn pin_message(
    State(state): State<Arc<AppState>>,
    Path((room_id, event_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    require_membership(&state, &room_id, &user_id).await?;

    if !can_manage_messages(&state, &room_id, &user_id).await {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "You do not have permission to pin messages in this room",
        ));
    }

    let msg_coll = state.db.collection::<mongodb::bson::Document>("messages");
    let message = msg_coll
        .find_one(doc! { "event_id": &event_id, "room_id": &room_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Message not found"))?;

    if message.get_bool("redacted").unwrap_or(false) {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "Cannot pin a deleted message",
        ));
    }
    if message.get_str("thread_id").is_ok() {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "Cannot pin a thread reply",
        ));
    }

    let channel_id = message.get_str("channel_id").unwrap_or("").to_string();
    require_channel_access(&state, &room_id, &user_id, &channel_id).await?;

    let pins_coll = state.db.collection::<PinRecord>("pins");
    if pins_coll
        .find_one(doc! { "_id": &event_id })
        .await
        .ok()
        .flatten()
        .is_some()
    {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "Message is already pinned",
        ));
    }

    let pin_count = pins_coll
        .count_documents(doc! { "room_id": &room_id, "channel_id": &channel_id })
        .await
        .unwrap_or(0);
    if pin_count >= MAX_PINS_PER_CHANNEL {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "This channel already has the maximum of 50 pinned messages",
        ));
    }

    let pinned_at = now_millis();
    let record = PinRecord {
        event_id: event_id.clone(),
        room_id: room_id.clone(),
        channel_id: channel_id.clone(),
        pinned_by: user_id.clone(),
        pinned_at,
    };
    pins_coll
        .insert_one(&record)
        .await
        .map_err(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "Failed to pin message"))?;

    // Carry the whole message so clients can render the new pin without refetching.
    let pinned_message = load_pinned_message(&state, &room_id, &record).await;
    let event = json!({
        "type": "m.room.pinned",
        "room_id": room_id,
        "channel_id": channel_id,
        "event_id": event_id,
        "pinned_by": user_id,
        "pinned_at": pinned_at,
        "message": pinned_message,
    });
    broadcast_to_room(&state, &room_id, &event).await;

    Ok(Json(json!({ "pinned": true, "pinned_at": pinned_at })))
}

/// DELETE /api/rooms/{room_id}/pins/{event_id}
pub(crate) async fn unpin_message(
    State(state): State<Arc<AppState>>,
    Path((room_id, event_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    require_membership(&state, &room_id, &user_id).await?;

    if !can_manage_messages(&state, &room_id, &user_id).await {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "You do not have permission to unpin messages in this room",
        ));
    }

    let pins_coll = state.db.collection::<PinRecord>("pins");
    let record = pins_coll
        .find_one(doc! { "_id": &event_id, "room_id": &room_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Message is not pinned"))?;

    let _ = pins_coll
        .delete_one(doc! { "_id": &event_id, "room_id": &room_id })
        .await;

    let event = json!({
        "type": "m.room.unpinned",
        "room_id": room_id,
        "channel_id": record.channel_id,
        "event_id": event_id,
        "sender": user_id,
    });
    broadcast_to_room(&state, &room_id, &event).await;

    Ok(Json(json!({ "unpinned": true })))
}

/// Drop the pin on a message that no longer exists (redacted or hard-deleted),
/// telling the room so open pin panels lose the entry too.
pub(crate) async fn remove_pin_for_event(state: &AppState, room_id: &str, event_id: &str) {
    let pins_coll = state.db.collection::<PinRecord>("pins");
    let existing = pins_coll
        .find_one(doc! { "_id": event_id, "room_id": room_id })
        .await
        .ok()
        .flatten();
    let Some(record) = existing else { return };

    let _ = pins_coll
        .delete_one(doc! { "_id": event_id, "room_id": room_id })
        .await;

    let event = json!({
        "type": "m.room.unpinned",
        "room_id": room_id,
        "channel_id": record.channel_id,
        "event_id": event_id,
    });
    broadcast_to_room(state, room_id, &event).await;
}

async fn require_membership(
    state: &AppState,
    room_id: &str,
    user_id: &str,
) -> Result<(), (StatusCode, Json<Value>)> {
    let rooms_coll = state.db.collection::<RoomRecord>("rooms");
    if rooms_coll
        .find_one(doc! { "_id": room_id })
        .await
        .ok()
        .flatten()
        .is_none()
    {
        return Err(error_response(StatusCode::NOT_FOUND, "Room not found"));
    }

    let rm = state.room_members.read().await;
    if !rm
        .get(room_id)
        .map(|m| m.contains(&user_id.to_string()))
        .unwrap_or(false)
    {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "Not a member of this room",
        ));
    }
    Ok(())
}

/// A pin must not leak a message out of a channel the caller cannot see.
async fn require_channel_access(
    state: &AppState,
    room_id: &str,
    user_id: &str,
    channel_id: &str,
) -> Result<(), (StatusCode, Json<Value>)> {
    if channel_id.is_empty() {
        return Ok(());
    }
    if let Some(allowed) = get_allowed_channel_ids(state, room_id, user_id).await {
        if !allowed.iter().any(|c| c == channel_id) {
            return Err(error_response(
                StatusCode::FORBIDDEN,
                "You do not have access to this channel",
            ));
        }
    }
    Ok(())
}

/// Hydrate a pin record into the message it points at, tagged with who pinned it
/// and when. Returns None if the message has since been deleted.
async fn load_pinned_message(state: &AppState, room_id: &str, record: &PinRecord) -> Option<Value> {
    let msg_coll = state.db.collection::<mongodb::bson::Document>("messages");
    let mut doc = msg_coll
        .find_one(doc! { "event_id": &record.event_id, "room_id": room_id })
        .await
        .ok()
        .flatten()?;
    if doc.get_bool("redacted").unwrap_or(false) {
        return None;
    }
    doc.remove("_id");

    let mut value = serde_json::to_value(&doc).ok()?;
    let obj = value.as_object_mut()?;
    obj.insert("pinned_by".to_string(), json!(record.pinned_by));
    obj.insert("pinned_at".to_string(), json!(record.pinned_at));
    Some(value)
}
