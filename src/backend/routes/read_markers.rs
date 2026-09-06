//! Per-user read markers and the unread counts derived from them.
//!
//! Unread state used to live only in the client reducer, so a refresh wiped it
//! and every channel read as caught up. A marker records the timestamp a user
//! last read a channel; unread counts are whatever arrived after it.

use super::super::{
    helpers::{
        error_response, extract_token, get_allowed_channel_ids, get_user_from_token, mention_token,
        now_millis, regex_escape,
    },
    state::{AppState, ChannelRecord},
};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::Json,
};
use futures_util::TryStreamExt;
use mongodb::bson::{doc, Document};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

#[derive(Deserialize)]
pub(crate) struct MarkReadRequest {
    /// Empty or absent for rooms whose messages carry no channel_id (DMs).
    pub(crate) channel_id: Option<String>,
    /// Marker position; defaults to now. Clamped so a marker never moves backwards.
    pub(crate) ts: Option<i64>,
}

fn marker_id(user_id: &str, channel_id: &str) -> String {
    format!("{user_id}|{channel_id}")
}

/// Record that `user_id` has read `channel_id` up to a point in time.
///
/// Markers only ever move forward: reading an older channel view must not
/// resurrect messages the user already dismissed elsewhere.
pub(crate) async fn mark_read(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
    Json(req): Json<MarkReadRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    {
        let rm = state.room_members.read().await;
        if !rm
            .get(&room_id)
            .map(|m| m.contains(&user_id))
            .unwrap_or(false)
        {
            return Err(error_response(
                StatusCode::FORBIDDEN,
                "Not a member of this room",
            ));
        }
    }

    let channel_id = req.channel_id.unwrap_or_default();
    let ts = req.ts.unwrap_or_else(now_millis);
    let id = marker_id(&user_id, &channel_id);

    let coll = state.db.collection::<Document>("read_markers");
    let existing = coll
        .find_one(doc! { "_id": &id })
        .await
        .ok()
        .flatten()
        .and_then(|d| d.get_i64("last_read_ts").ok())
        .unwrap_or(0);
    if ts <= existing {
        return Ok(Json(json!({ "last_read_ts": existing })));
    }

    let _ = coll
        .update_one(
            doc! { "_id": &id },
            doc! { "$set": {
                "user_id": &user_id,
                "room_id": &room_id,
                "channel_id": &channel_id,
                "last_read_ts": ts,
            }},
        )
        .upsert(true)
        .await;

    Ok(Json(json!({ "last_read_ts": ts })))
}

/// Unread and mention counts for every room the caller has joined.
///
/// One aggregation per visible channel; both counts come back together so a
/// mention scan costs no extra round trip.
pub(crate) async fn get_unreads(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let joined_rooms: Vec<String> = {
        let rm = state.room_members.read().await;
        rm.iter()
            .filter(|(_, members)| members.contains(&user_id))
            .map(|(room_id, _)| room_id.clone())
            .collect()
    };

    // Markers for this user, keyed by channel_id ("" for channel-less rooms).
    let markers_coll = state.db.collection::<Document>("read_markers");
    let mut markers: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
    if let Ok(mut cursor) = markers_coll.find(doc! { "user_id": &user_id }).await {
        while let Ok(Some(d)) = cursor.try_next().await {
            let channel_id = d.get_str("channel_id").unwrap_or("").to_string();
            markers.insert(channel_id, d.get_i64("last_read_ts").unwrap_or(0));
        }
    }

    let channels_coll = state.db.collection::<ChannelRecord>("channels");
    let messages_coll = state.db.collection::<Document>("messages");
    let mention = mention_token(&user_id);

    let mut unreads: Vec<Value> = Vec::new();
    for room_id in &joined_rooms {
        let allowed = get_allowed_channel_ids(&state, room_id, &user_id).await;

        // Channel ids to tally. A room with no channels still carries messages
        // with an empty channel_id, so "" is always considered.
        let mut channel_ids: Vec<String> = vec![String::new()];
        if let Ok(mut cursor) = channels_coll.find(doc! { "room_id": room_id }).await {
            while let Ok(Some(ch)) = cursor.try_next().await {
                if ch.channel_type != "text" {
                    continue;
                }
                if let Some(ref allowed) = allowed {
                    if !allowed.contains(&ch.channel_id) {
                        continue;
                    }
                }
                channel_ids.push(ch.channel_id);
            }
        }

        for channel_id in channel_ids {
            let since = markers.get(&channel_id).copied().unwrap_or(0);
            let mut match_doc = doc! {
                "room_id": room_id,
                "type": "m.room.message",
                "origin_server_ts": { "$gt": since },
                "sender": { "$ne": &user_id },
                "content.msgtype": { "$ne": "m.system" },
            };
            if channel_id.is_empty() {
                match_doc.insert("channel_id", doc! { "$exists": false });
            } else {
                match_doc.insert("channel_id", &channel_id);
            }

            let pipeline = vec![
                doc! { "$match": match_doc },
                doc! { "$group": {
                    "_id": Value::Null.to_string(),
                    "count": { "$sum": 1 },
                    "mentions": { "$sum": {
                        "$cond": [
                            { "$regexMatch": {
                                "input": { "$ifNull": ["$content.body", ""] },
                                "regex": regex_escape(&mention),
                            }},
                            1,
                            0,
                        ]
                    }},
                }},
            ];

            let Ok(mut cursor) = messages_coll.aggregate(pipeline).await else {
                continue;
            };
            if let Ok(Some(row)) = cursor.try_next().await {
                let count = row.get_i32("count").unwrap_or(0);
                let mentions = row.get_i32("mentions").unwrap_or(0);
                if count > 0 {
                    unreads.push(json!({
                        "room_id": room_id,
                        "channel_id": channel_id,
                        "count": count,
                        "mentions": mentions,
                    }));
                }
            }
        }
    }

    Ok(Json(json!({ "unreads": unreads })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marker_id_is_scoped_per_user_and_channel() {
        assert_eq!(marker_id("@a:h", "#c"), "@a:h|#c");
        assert_ne!(marker_id("@a:h", "#c"), marker_id("@b:h", "#c"));
    }
}
