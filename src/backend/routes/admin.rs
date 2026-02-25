use super::super::{
    helpers::{error_response, hash_password, require_admin},
    state::{AppState, UploadRecord, UserRecord},
};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::Json,
};
use mongodb::bson::doc;
use rand::Rng;
use serde_json::{json, Value};
use std::sync::Arc;

/// GET /api/admin/stats
pub(crate) async fn admin_stats(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    require_admin(&state, &headers).await?;

    let users_count = state
        .db
        .collection::<UserRecord>("users")
        .count_documents(doc! {})
        .await
        .unwrap_or(0);
    let rooms_count = state
        .db
        .collection::<mongodb::bson::Document>("rooms")
        .count_documents(doc! {})
        .await
        .unwrap_or(0);
    let messages_count = state
        .db
        .collection::<mongodb::bson::Document>("messages")
        .count_documents(doc! {})
        .await
        .unwrap_or(0);
    let uploads_count = state
        .db
        .collection::<UploadRecord>("uploads")
        .count_documents(doc! {})
        .await
        .unwrap_or(0);

    // Aggregate total file size
    let total_size: u64 = {
        use futures_util::TryStreamExt;
        let coll = state.db.collection::<UploadRecord>("uploads");
        let mut cursor = coll.find(doc! {}).await.map_err(|_| {
            error_response(StatusCode::INTERNAL_SERVER_ERROR, "DB error")
        })?;
        let mut total = 0u64;
        while let Some(upload) = cursor.try_next().await.unwrap_or(None) {
            total += upload.size;
        }
        total
    };

    // Count online users from presence cache
    let online_users = {
        let presence = state.user_presence.read().await;
        presence.values().filter(|p| p.connected).count()
    };

    Ok(Json(json!({
        "users": users_count,
        "rooms": rooms_count,
        "messages": messages_count,
        "uploads": uploads_count,
        "total_file_size": total_size,
        "online_users": online_users
    })))
}

/// GET /api/admin/users
pub(crate) async fn admin_list_users(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    require_admin(&state, &headers).await?;

    use futures_util::TryStreamExt;
    let users_coll = state.db.collection::<UserRecord>("users");
    let mut cursor = users_coll.find(doc! {}).await.map_err(|_| {
        error_response(StatusCode::INTERNAL_SERVER_ERROR, "DB error")
    })?;

    let presence = state.user_presence.read().await;
    let room_members = state.room_members.read().await;

    let mut users = Vec::new();
    while let Some(user) = cursor.try_next().await.unwrap_or(None) {
        let is_online = presence
            .get(&user.user_id)
            .map(|p| p.connected)
            .unwrap_or(false);

        // Count rooms this user is in
        let room_count = room_members
            .values()
            .filter(|members| members.contains(&user.user_id))
            .count();

        users.push(json!({
            "user_id": user.user_id,
            "display_name": user.display_name,
            "avatar_url": user.avatar_url,
            "is_admin": user.is_admin,
            "disabled": user.disabled,
            "totp_verified": user.totp_verified,
            "room_count": room_count,
            "online": is_online
        }));
    }

    Ok(Json(json!({ "users": users })))
}

/// POST /api/admin/users/{user_id}/disable
pub(crate) async fn admin_disable_user(
    State(state): State<Arc<AppState>>,
    Path(user_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let admin_id = require_admin(&state, &headers).await?;

    let target_id = format!("@{}:localhost", user_id);
    if target_id == admin_id {
        return Err(error_response(StatusCode::BAD_REQUEST, "Cannot disable yourself"));
    }

    let users = state.db.collection::<UserRecord>("users");
    let result = users
        .update_one(
            doc! { "_id": &target_id },
            doc! { "$set": { "disabled": true } },
        )
        .await
        .map_err(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "DB error"))?;

    if result.matched_count == 0 {
        return Err(error_response(StatusCode::NOT_FOUND, "User not found"));
    }

    // Disconnect their WebSocket
    state.active_websockets.write().await.remove(&target_id);

    Ok(Json(json!({ "disabled": true })))
}

/// POST /api/admin/users/{user_id}/enable
pub(crate) async fn admin_enable_user(
    State(state): State<Arc<AppState>>,
    Path(user_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    require_admin(&state, &headers).await?;

    let target_id = format!("@{}:localhost", user_id);
    let users = state.db.collection::<UserRecord>("users");
    let result = users
        .update_one(
            doc! { "_id": &target_id },
            doc! { "$set": { "disabled": false } },
        )
        .await
        .map_err(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "DB error"))?;

    if result.matched_count == 0 {
        return Err(error_response(StatusCode::NOT_FOUND, "User not found"));
    }

    Ok(Json(json!({ "enabled": true })))
}

/// DELETE /api/admin/users/{user_id}
pub(crate) async fn admin_delete_user(
    State(state): State<Arc<AppState>>,
    Path(user_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let admin_id = require_admin(&state, &headers).await?;

    let target_id = format!("@{}:localhost", user_id);
    if target_id == admin_id {
        return Err(error_response(StatusCode::BAD_REQUEST, "Cannot delete yourself"));
    }

    let users = state.db.collection::<UserRecord>("users");
    let result = users
        .delete_one(doc! { "_id": &target_id })
        .await
        .map_err(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "DB error"))?;

    if result.deleted_count == 0 {
        return Err(error_response(StatusCode::NOT_FOUND, "User not found"));
    }

    // Remove user from all rooms
    let _ = state
        .db
        .collection::<mongodb::bson::Document>("room_members")
        .delete_many(doc! { "user_id": &target_id })
        .await;

    // Update room_members cache
    {
        let mut rm = state.room_members.write().await;
        for members in rm.values_mut() {
            members.retain(|m| m != &target_id);
        }
    }

    // Remove from room_roles cache
    {
        let mut roles = state.room_roles.write().await;
        for role_map in roles.values_mut() {
            role_map.remove(&target_id);
        }
    }

    // Delete refresh tokens
    let _ = state
        .db
        .collection::<mongodb::bson::Document>("refresh_tokens")
        .delete_many(doc! { "user_id": &target_id })
        .await;

    // Close active WebSocket
    state.active_websockets.write().await.remove(&target_id);

    // Remove presence
    state.user_presence.write().await.remove(&target_id);

    Ok(Json(json!({ "deleted": true })))
}

/// POST /api/admin/users/{user_id}/reset-password
pub(crate) async fn admin_reset_password(
    State(state): State<Arc<AppState>>,
    Path(user_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    require_admin(&state, &headers).await?;

    let target_id = format!("@{}:localhost", user_id);

    // Generate random 12-char password (scope rng to avoid holding across await)
    let (temp_password, new_hash) = {
        let chars: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
        let mut rng = rand::thread_rng();
        let pw: String = (0..12)
            .map(|_| chars[rng.gen_range(0..chars.len())] as char)
            .collect();
        let hash = hash_password(&pw);
        (pw, hash)
    };

    let users = state.db.collection::<UserRecord>("users");
    let result = users
        .update_one(
            doc! { "_id": &target_id },
            doc! {
                "$set": {
                    "password_hash": new_hash,
                    "totp_secret": "",
                    "totp_verified": false,
                    "recovery_codes": mongodb::bson::Bson::Array(vec![])
                }
            },
        )
        .await
        .map_err(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "DB error"))?;

    if result.matched_count == 0 {
        return Err(error_response(StatusCode::NOT_FOUND, "User not found"));
    }

    Ok(Json(json!({ "temporary_password": temp_password })))
}

/// GET /api/admin/rooms
pub(crate) async fn admin_list_rooms(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    require_admin(&state, &headers).await?;

    use super::super::state::RoomRecord;
    use futures_util::TryStreamExt;

    let rooms_coll = state.db.collection::<RoomRecord>("rooms");
    let mut cursor = rooms_coll.find(doc! {}).await.map_err(|_| {
        error_response(StatusCode::INTERNAL_SERVER_ERROR, "DB error")
    })?;

    let room_members = state.room_members.read().await;

    let mut rooms = Vec::new();
    while let Some(room) = cursor.try_next().await.unwrap_or(None) {
        let member_count = room_members
            .get(&room.room_id)
            .map(|m| m.len())
            .unwrap_or(0);

        let message_count = state
            .db
            .collection::<mongodb::bson::Document>("messages")
            .count_documents(doc! { "room_id": &room.room_id })
            .await
            .unwrap_or(0);

        rooms.push(json!({
            "room_id": room.room_id,
            "name": room.name,
            "creator": room.creator,
            "is_dm": room.is_dm,
            "room_type": room.room_type,
            "member_count": member_count,
            "message_count": message_count
        }));
    }

    Ok(Json(json!({ "rooms": rooms })))
}

/// DELETE /api/admin/rooms/{room_id}
pub(crate) async fn admin_delete_room(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    require_admin(&state, &headers).await?;

    let db = &state.db;

    // Remove room document
    let result = db
        .collection::<mongodb::bson::Document>("rooms")
        .delete_one(doc! { "_id": &room_id })
        .await
        .map_err(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "DB error"))?;

    if result.deleted_count == 0 {
        return Err(error_response(StatusCode::NOT_FOUND, "Room not found"));
    }

    // Remove related data from MongoDB
    let _ = db
        .collection::<mongodb::bson::Document>("room_members")
        .delete_many(doc! { "room_id": &room_id })
        .await;
    let _ = db
        .collection::<mongodb::bson::Document>("messages")
        .delete_many(doc! { "room_id": &room_id })
        .await;
    let _ = db
        .collection::<mongodb::bson::Document>("banned_users")
        .delete_many(doc! { "room_id": &room_id })
        .await;
    let _ = db
        .collection::<mongodb::bson::Document>("invites")
        .delete_many(doc! { "room_id": &room_id })
        .await;
    let _ = db
        .collection::<mongodb::bson::Document>("forum_posts")
        .delete_many(doc! { "room_id": &room_id })
        .await;
    let _ = db
        .collection::<mongodb::bson::Document>("forum_comments")
        .delete_many(doc! { "room_id": &room_id })
        .await;
    let _ = db
        .collection::<mongodb::bson::Document>("whiteboard_strokes")
        .delete_many(doc! { "room_id": &room_id })
        .await;

    // Clean up in-memory caches
    state.room_members.write().await.remove(&room_id);
    state.room_roles.write().await.remove(&room_id);
    state.banned_users.write().await.remove(&room_id);
    state.voice_channels.write().await.remove(&room_id);

    Ok(Json(json!({ "deleted": true })))
}
