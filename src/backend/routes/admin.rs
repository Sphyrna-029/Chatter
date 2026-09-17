use super::super::{
    app::generate_invite_code,
    helpers::{error_response, hash_password, now_secs, presence_status, require_admin},
    metrics::{resident_bytes, METRICS},
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
        let mut cursor = coll
            .find(doc! {})
            .await
            .map_err(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "DB error"))?;
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

    // Storage that is not a finished upload. Orphaned disk is the kind of
    // problem nobody sees until a volume fills, and these three numbers are
    // the difference between noticing it in March and noticing it at 2am:
    // what is part-way through arriving, what has arrived and been claimed by
    // nothing, and what the last reclaim pass actually took.
    let staging_bytes = super::media::staging_bytes_for(None).await;
    let unreferenced_bytes: u64 = {
        use futures_util::TryStreamExt;
        let coll = state.db.collection::<UploadRecord>("uploads");
        let mut total = 0u64;
        if let Ok(mut cursor) = coll.find(doc! { "referenced_at": null }).await {
            while let Ok(Some(upload)) = cursor.try_next().await {
                total += upload.size;
            }
        }
        total
    };
    let last_reclaim = super::media::LAST_RECLAIM
        .lock()
        .map(|report| *report)
        .unwrap_or_default();

    Ok(Json(json!({
        "users": users_count,
        "rooms": rooms_count,
        "messages": messages_count,
        "uploads": uploads_count,
        "total_file_size": total_size,
        "online_users": online_users,
        "staging_bytes": staging_bytes,
        "unreferenced_bytes": unreferenced_bytes,
        "last_reclaim": {
            "ran_at_ms": last_reclaim.ran_at_ms,
            "considered": last_reclaim.considered,
            "kept": last_reclaim.kept,
            "reclaimed": last_reclaim.reclaimed,
            "reclaimed_bytes": last_reclaim.reclaimed_bytes,
            "dry_run": last_reclaim.dry_run,
        }
    })))
}

/// GET /api/admin/metrics
///
/// A live picture of the media plane and the ephemeral state around it — the
/// two things `admin_stats` cannot show, because they are not in the database.
///
/// Counters are cumulative; the caller polls and diffs against `timestamp_ms`
/// to get rates. Nothing here touches Mongo, so it is cheap enough to poll on
/// a few-second interval while watching a call.
pub(crate) async fn admin_metrics(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    require_admin(&state, &headers).await?;

    // Sockets, not people: one user with a phone and a desktop holds two.
    let (socket_count, connected_users) = {
        let ws = state.active_websockets.read().await;
        (
            ws.values().map(|conns| conns.len()).sum::<usize>(),
            ws.len(),
        )
    };

    let (voice_channels_active, voice_members) = {
        let channels = state.voice_channels.read().await;
        let occupied = channels.values().filter(|m| !m.is_empty()).count();
        (occupied, channels.values().map(|m| m.len()).sum::<usize>())
    };

    let voice_publishers = state.voice_publishers.read().await.len();
    let voice_listeners = state.voice_listeners.read().await.len();
    let screen_publishers = state.screen_publishers.read().await.len();
    let screen_subscribers = state.screen_subscribers.read().await.len();
    let webcam_publishers = state.webcam_publishers.read().await.len();
    let webcam_subscribers = state.webcam_subscribers.read().await.len();

    // Maps that grow with use and are only ever trimmed incidentally. Watching
    // them is how a leak gets noticed before it is an out-of-memory kill.
    let caches = json!({
        "rate_limit_buckets": state.rate_limits.read().await.len(),
        "link_previews": state.link_previews.read().await.len(),
        "presence_entries": state.user_presence.read().await.len(),
        "watch_parties": state.watch_party_rooms.read().await.len(),
        "voice_speaking_channels": state.voice_speaking.read().await.len(),
        "room_member_cache": state.room_members.read().await.len(),
    });

    let mut snapshot = METRICS.snapshot();
    if let Some(obj) = snapshot.as_object_mut() {
        obj.insert(
            "timestamp_ms".into(),
            json!(super::super::helpers::now_millis()),
        );
        obj.insert(
            "connections".into(),
            json!({ "sockets": socket_count, "users": connected_users }),
        );
        obj.insert(
            "sessions".into(),
            json!({
                "voice_channels_active": voice_channels_active,
                "voice_members": voice_members,
                "voice_publishers": voice_publishers,
                "voice_listeners": voice_listeners,
                "screen_publishers": screen_publishers,
                "screen_subscribers": screen_subscribers,
                "webcam_publishers": webcam_publishers,
                "webcam_subscribers": webcam_subscribers,
            }),
        );
        obj.insert("caches".into(), caches);
        obj.insert("resident_bytes".into(), json!(resident_bytes()));
    }

    Ok(Json(snapshot))
}

/// GET /api/admin/users
pub(crate) async fn admin_list_users(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    require_admin(&state, &headers).await?;

    use futures_util::TryStreamExt;
    let users_coll = state.db.collection::<UserRecord>("users");
    let mut cursor = users_coll
        .find(doc! {})
        .await
        .map_err(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "DB error"))?;

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
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "Cannot disable yourself",
        ));
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
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "Cannot delete yourself",
        ));
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

    // Same as a self-deletion: the account going away takes its uploads.
    super::media::purge_user_uploads(&state, &target_id).await;
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
    let mut cursor = rooms_coll
        .find(doc! {})
        .await
        .map_err(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "DB error"))?;

    let mut room_records = Vec::new();
    while let Some(room) = cursor.try_next().await.unwrap_or(None) {
        room_records.push(room);
    }

    let stats = room_statistics(&state).await;
    let channel_counts = count_by_room(&state, "channels").await;
    let thread_counts = count_by_room(&state, "threads").await;

    // Snapshot both caches rather than reading under a guard held across the
    // loop, as everything else on this path now does.
    let members: std::collections::HashMap<String, Vec<String>> = {
        let rm = state.room_members.read().await;
        rm.clone()
    };
    let online: std::collections::HashSet<String> = {
        let now = now_secs();
        let up = state.user_presence.read().await;
        up.iter()
            .filter(|(_, p)| presence_status(p, now) != "offline")
            .map(|(user_id, _)| user_id.clone())
            .collect()
    };

    let mut rooms = Vec::new();
    for room in room_records {
        let room_members = members.get(&room.room_id);
        let member_count = room_members.map(|m| m.len()).unwrap_or(0);
        let online_count = room_members
            .map(|m| m.iter().filter(|id| online.contains(*id)).count())
            .unwrap_or(0);
        let stat = stats.get(&room.room_id);

        rooms.push(json!({
            "room_id": room.room_id,
            "name": room.name,
            "creator": room.creator,
            "is_dm": room.is_dm,
            "room_type": room.room_type,
            "member_count": member_count,
            "online_count": online_count,
            "message_count": stat.map(|s| s.messages).unwrap_or(0),
            "last_activity": stat.map(|s| s.last_activity).unwrap_or(0),
            "channel_count": channel_counts.get(&room.room_id).copied().unwrap_or(0),
            "thread_count": thread_counts.get(&room.room_id).copied().unwrap_or(0),
            "file_count": stat.map(|s| s.file_count).unwrap_or(0),
            "storage_bytes": stat.map(|s| s.storage_bytes).unwrap_or(0),
        }));
    }

    Ok(Json(json!({ "rooms": rooms })))
}

/// What one room's messages add up to.
#[derive(Default)]
struct RoomStatistics {
    messages: u64,
    /// Newest `origin_server_ts` in the room, or 0 for a room nobody has
    /// written in.
    last_activity: i64,
    file_count: u64,
    storage_bytes: u64,
}

/// Message, activity and attachment totals for every room, in one pass.
///
/// This replaces a `count_documents` per room, which meant a query per room on
/// a page that lists all of them. It has to read message bodies regardless —
/// an upload is linked to a room only by its URL appearing in one, there being
/// no room_id on an upload record — so counting and finding the newest
/// timestamp in the same pass costs nothing beyond it.
///
/// Attachments are matched with `attachment_folders`, the same function the
/// housekeeping passes use to decide what a message still references, so the
/// dashboard cannot disagree with the sweeper about what a room is holding
/// on to.
///
/// A file posted in two rooms counts once in each: there is one copy on disk,
/// but both rooms are keeping it alive. Per-room storage therefore sums to
/// more than the disk usage, which is the honest answer to "what would
/// deleting this room free" rather than to "where did the bytes go".
async fn room_statistics(state: &AppState) -> std::collections::HashMap<String, RoomStatistics> {
    use super::media::attachment_folders;
    use futures_util::TryStreamExt;
    use std::collections::{HashMap, HashSet};

    let mut out: HashMap<String, RoomStatistics> = HashMap::new();
    let mut folders: HashMap<String, HashSet<String>> = HashMap::new();

    let messages = state.db.collection::<mongodb::bson::Document>("messages");
    let Ok(mut cursor) = messages
        .find(doc! {})
        .projection(doc! { "room_id": 1, "content.body": 1, "origin_server_ts": 1 })
        .await
    else {
        return out;
    };

    while let Ok(Some(doc)) = cursor.try_next().await {
        let Ok(room_id) = doc.get_str("room_id") else {
            continue;
        };
        let entry = out.entry(room_id.to_string()).or_default();
        entry.messages += 1;

        // Written as i64 now and as i32 by older builds.
        let ts = doc
            .get_i64("origin_server_ts")
            .or_else(|_| doc.get_i32("origin_server_ts").map(i64::from))
            .unwrap_or(0);
        if ts > entry.last_activity {
            entry.last_activity = ts;
        }

        if let Some(body) = doc
            .get_document("content")
            .ok()
            .and_then(|content| content.get_str("body").ok())
        {
            let found = attachment_folders(body);
            if !found.is_empty() {
                folders
                    .entry(room_id.to_string())
                    .or_default()
                    .extend(found);
            }
        }
    }

    if folders.is_empty() {
        return out;
    }

    // One read of the upload records, then the sizes are looked up per room.
    let mut folder_sizes: HashMap<String, u64> = HashMap::new();
    let uploads = state.db.collection::<mongodb::bson::Document>("uploads");
    if let Ok(mut cursor) = uploads
        .find(doc! {})
        .projection(doc! { "folder": 1, "size": 1 })
        .await
    {
        while let Ok(Some(doc)) = cursor.try_next().await {
            let Ok(folder) = doc.get_str("folder") else {
                continue;
            };
            let size = doc
                .get_i64("size")
                .or_else(|_| doc.get_i32("size").map(i64::from))
                .unwrap_or(0);
            if size > 0 {
                folder_sizes.insert(folder.to_string(), size as u64);
            }
        }
    }

    for (room_id, room_folders) in folders {
        let entry = out.entry(room_id).or_default();
        for folder in room_folders {
            if let Some(&size) = folder_sizes.get(&folder) {
                entry.file_count += 1;
                entry.storage_bytes += size;
            }
        }
    }

    out
}

/// How many documents each room has in `collection`, grouped by the database
/// rather than counted a room at a time.
async fn count_by_room(
    state: &AppState,
    collection: &str,
) -> std::collections::HashMap<String, u64> {
    use futures_util::TryStreamExt;

    let mut out = std::collections::HashMap::new();
    let coll = state.db.collection::<mongodb::bson::Document>(collection);
    let Ok(mut cursor) = coll
        .aggregate(vec![
            doc! { "$group": { "_id": "$room_id", "n": { "$sum": 1 } } },
        ])
        .await
    else {
        return out;
    };
    while let Ok(Some(doc)) = cursor.try_next().await {
        let Ok(room_id) = doc.get_str("_id") else {
            continue;
        };
        let n = doc
            .get_i64("n")
            .or_else(|_| doc.get_i32("n").map(i64::from))
            .unwrap_or(0);
        out.insert(room_id.to_string(), n.max(0) as u64);
    }
    out
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

/// GET /api/admin/settings
pub(crate) async fn admin_get_settings(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    require_admin(&state, &headers).await?;

    let settings = state.server_settings.read().await;
    Ok(Json(json!({
        "invite_only": settings.invite_only,
        "invite_code": settings.invite_code,
        "storage_limit_bytes": settings.storage_limit_bytes,
        "upload_limit_bytes": settings.upload_limit_bytes,
        "room_creation_limit": settings.room_creation_limit,
        "require_auth_for_uploads": settings.require_auth_for_uploads,
        "room_creation_disabled": settings.room_creation_disabled,
        "reclaim_unreferenced_uploads": settings.reclaim_unreferenced_uploads
    })))
}

/// PUT /api/admin/settings
pub(crate) async fn admin_update_settings(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    require_admin(&state, &headers).await?;

    // Build $set doc from whichever fields are present
    let mut set_doc = mongodb::bson::Document::new();

    if let Some(invite_only) = body.get("invite_only").and_then(|v| v.as_bool()) {
        set_doc.insert("invite_only", invite_only);
    }
    if let Some(storage_limit) = body.get("storage_limit_bytes").and_then(|v| v.as_u64()) {
        set_doc.insert("storage_limit_bytes", storage_limit as i64);
    }
    if let Some(upload_limit) = body.get("upload_limit_bytes").and_then(|v| v.as_u64()) {
        set_doc.insert("upload_limit_bytes", upload_limit as i64);
    }
    if let Some(room_limit) = body.get("room_creation_limit").and_then(|v| v.as_u64()) {
        set_doc.insert("room_creation_limit", room_limit as i64);
    }
    if let Some(reclaim) = body
        .get("reclaim_unreferenced_uploads")
        .and_then(|v| v.as_bool())
    {
        set_doc.insert("reclaim_unreferenced_uploads", reclaim);
    }
    if let Some(require_auth) = body
        .get("require_auth_for_uploads")
        .and_then(|v| v.as_bool())
    {
        set_doc.insert("require_auth_for_uploads", require_auth);
    }
    if let Some(room_creation_disabled) =
        body.get("room_creation_disabled").and_then(|v| v.as_bool())
    {
        set_doc.insert("room_creation_disabled", room_creation_disabled);
    }

    if set_doc.is_empty() {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "No valid fields to update",
        ));
    }

    // Update DB
    let coll = state
        .db
        .collection::<mongodb::bson::Document>("server_settings");
    coll.update_one(doc! { "_id": "global" }, doc! { "$set": set_doc.clone() })
        .await
        .map_err(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "DB error"))?;

    // Update cache
    {
        let mut settings = state.server_settings.write().await;
        if let Ok(val) = set_doc.get_bool("invite_only") {
            settings.invite_only = val;
        }
        if let Ok(val) = set_doc.get_i64("storage_limit_bytes") {
            settings.storage_limit_bytes = val as u64;
        }
        if let Ok(val) = set_doc.get_i64("upload_limit_bytes") {
            settings.upload_limit_bytes = val as u64;
        }
        if let Ok(val) = set_doc.get_i64("room_creation_limit") {
            settings.room_creation_limit = val as u64;
        }
        if let Ok(val) = set_doc.get_bool("require_auth_for_uploads") {
            settings.require_auth_for_uploads = val;
        }
        if let Ok(val) = set_doc.get_bool("room_creation_disabled") {
            settings.room_creation_disabled = val;
        }
        if let Ok(val) = set_doc.get_bool("reclaim_unreferenced_uploads") {
            settings.reclaim_unreferenced_uploads = val;
        }
    }

    Ok(Json(json!({ "ok": true })))
}

/// POST /api/admin/settings/refresh-invite
pub(crate) async fn admin_refresh_invite(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    require_admin(&state, &headers).await?;

    let new_code = generate_invite_code();

    // Update DB
    let coll = state
        .db
        .collection::<mongodb::bson::Document>("server_settings");
    coll.update_one(
        doc! { "_id": "global" },
        doc! { "$set": { "invite_code": &new_code } },
    )
    .await
    .map_err(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "DB error"))?;

    // Update cache
    {
        let mut settings = state.server_settings.write().await;
        settings.invite_code = new_code.clone();
    }

    Ok(Json(json!({ "invite_code": new_code })))
}
