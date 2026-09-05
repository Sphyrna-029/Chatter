use super::super::{
    helpers::{error_response, extract_token, get_user_from_token, now_secs},
    state::{AppState, PresenceRecord, RoomRecord, UserRecord},
};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::Json,
};
use mongodb::bson::doc;
use serde_json::{json, Value};
use std::sync::Arc;

pub(crate) async fn get_voice_channel_status(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let _user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let rooms_coll = state.db.collection::<RoomRecord>("rooms");
    if rooms_coll
        .find_one(doc! { "_id": &room_id })
        .await
        .ok()
        .flatten()
        .is_none()
    {
        return Err(error_response(StatusCode::NOT_FOUND, "Room not found"));
    }

    // Fetch channels for this room to know which channel_ids belong to it
    let channels_coll = state
        .db
        .collection::<super::super::state::ChannelRecord>("channels");
    let mut channel_ids: Vec<String> = Vec::new();
    if let Ok(mut cursor) = channels_coll
        .find(mongodb::bson::doc! { "room_id": &room_id, "channel_type": "voice" })
        .await
    {
        while let Ok(Some(ch)) = futures_util::TryStreamExt::try_next(&mut cursor).await {
            channel_ids.push(ch.channel_id);
        }
    }

    let vc = state.voice_channels.read().await;
    let occupied_since_map = state.voice_channel_occupied_since.read().await;

    // Build voice_members list (flat, for backward compat) and voice_channels map (by channel_id)
    let mut voice_members: Vec<Value> = Vec::new();
    let mut voice_channels_map = serde_json::Map::new();
    let mut occupied_since_out = serde_json::Map::new();

    // Also check the room_id key for backward compat (pre-channels data)
    let mut keys_to_check = channel_ids.clone();
    keys_to_check.push(room_id.clone());

    for key in &keys_to_check {
        if let Some(members) = vc.get(key) {
            let mut channel_members: Vec<Value> = Vec::new();
            for (uid, vs) in members {
                let entry = json!({
                    "user_id": uid,
                    "muted": vs.muted,
                    "deafened": vs.deafened,
                    "screen_sharing": vs.screen_sharing,
                    "clipping": vs.clipping,
                    "force_muted": vs.force_muted,
                    "channel_id": key
                });
                voice_members.push(entry.clone());
                channel_members.push(entry);
            }
            if !channel_members.is_empty() {
                voice_channels_map.insert(key.clone(), json!(channel_members));
                if let Some(&since) = occupied_since_map.get(key) {
                    occupied_since_out.insert(key.clone(), json!(since));
                }
            }
        }
    }

    Ok(Json(json!({
        "room_id": room_id,
        "voice_members": voice_members,
        "voice_channels": Value::Object(voice_channels_map),
        "occupied_since": Value::Object(occupied_since_out)
    })))
}

// ---------------------------------------------------------------------------
// Presence
// ---------------------------------------------------------------------------

/// The presence record the client expects for one user: their live status when
/// the server has seen them, and their stored profile either way, so an offline
/// user still renders with their avatar and display name.
///
/// Shared with the friends endpoint, which reports on people the caller may not
/// share a room with — the two must not drift apart.
pub(crate) async fn build_presence_entry(
    state: &AppState,
    up: &std::collections::HashMap<String, PresenceRecord>,
    user_id: &str,
    current_time: f64,
) -> Value {
    let users_coll = state.db.collection::<UserRecord>("users");
    let user_record = users_coll
        .find_one(doc! { "_id": user_id })
        .await
        .ok()
        .flatten();
    let avatar_url = user_record
        .as_ref()
        .map(|u| u.avatar_url.as_str())
        .unwrap_or("");
    let about = user_record.as_ref().map(|u| u.about.as_str()).unwrap_or("");
    let banner_url = user_record
        .as_ref()
        .map(|u| u.banner_url.as_str())
        .unwrap_or("");
    let display_name = user_record
        .as_ref()
        .map(|u| u.display_name.as_str())
        .unwrap_or("");
    let name_font_url = user_record
        .as_ref()
        .map(|u| u.name_font_url.as_str())
        .unwrap_or("");

    match up.get(user_id) {
        Some(presence) => {
            let time_since_active = current_time - presence.last_active;
            let status = if !presence.connected {
                "offline"
            } else if let Some(ref ms) = presence.manual_status {
                ms.as_str()
            } else if time_since_active < 300.0 {
                "active"
            } else {
                "idle"
            };

            json!({
                "status": status,
                "last_active": presence.last_active,
                "last_typing": presence.last_typing,
                "custom_status": presence.custom_status,
                "avatar_url": avatar_url,
                "about": about,
                "banner_url": banner_url,
                "display_name": display_name,
                "name_font_url": name_font_url,
                "is_mobile": presence.is_mobile,
                "steam_game": presence.steam_game,
                "steam_appid": presence.steam_appid,
                "game_session_start": presence.game_session_start,
                "spotify_track": presence.spotify_track,
                "spotify_artist": presence.spotify_artist,
                "spotify_album_art": presence.spotify_album_art,
            })
        }
        None => json!({
            "status": "offline",
            "last_active": 0,
            "last_typing": 0,
            "avatar_url": avatar_url,
            "about": about,
            "banner_url": banner_url,
            "display_name": display_name,
            "name_font_url": name_font_url,
            "is_mobile": false,
            "steam_game": null,
            "steam_appid": null,
            "game_session_start": null,
            "spotify_track": null,
            "spotify_artist": null,
            "spotify_album_art": null,
        }),
    }
}

pub(crate) async fn get_room_presence(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let _user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let rooms_coll = state.db.collection::<RoomRecord>("rooms");
    if rooms_coll
        .find_one(doc! { "_id": &room_id })
        .await
        .ok()
        .flatten()
        .is_none()
    {
        return Err(error_response(StatusCode::NOT_FOUND, "Room not found"));
    }

    let current_time = now_secs();
    let rm = state.room_members.read().await;
    let up = state.user_presence.read().await;

    let mut presence_data = serde_json::Map::new();

    if let Some(members) = rm.get(&room_id) {
        for member_id in members {
            presence_data.insert(
                member_id.clone(),
                build_presence_entry(&state, &up, member_id, current_time).await,
            );
        }
    }

    Ok(Json(json!({
        "room_id": room_id,
        "presence": Value::Object(presence_data)
    })))
}
