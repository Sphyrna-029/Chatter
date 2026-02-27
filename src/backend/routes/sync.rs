use super::super::{
    dto::SyncQuery,
    helpers::{error_response, extract_token, get_reactions_for_events, get_user_from_token},
    state::{AppState, RoomRecord, UserRecord},
};
use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::Json,
};
use futures_util::TryStreamExt;
use mongodb::bson::doc;
use serde_json::{json, Value};
use std::{sync::Arc, time::SystemTime};

pub(crate) async fn sync(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(_query): Query<SyncQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let rm = state.room_members.read().await;
    let room_roles = state.room_roles.read().await;
    let rooms_coll = state.db.collection::<RoomRecord>("rooms");
    let msg_coll = state.db.collection::<mongodb::bson::Document>("messages");
    let users_coll = state.db.collection::<UserRecord>("users");

    let mut joined_rooms_data = serde_json::Map::new();

    for (room_id, members) in rm.iter() {
        if !members.contains(&user_id) {
            continue;
        }

        let room_data = match rooms_coll.find_one(doc! { "_id": room_id }).await {
            Ok(Some(r)) => r,
            _ => continue,
        };

        // Fetch last 10 messages from MongoDB
        let mut last_msgs: Vec<Value> = Vec::new();
        if let Ok(mut cursor) = msg_coll
            .find(doc! { "room_id": room_id })
            .sort(doc! { "origin_server_ts": -1 })
            .limit(10)
            .await
        {
            while let Ok(Some(doc)) = cursor.try_next().await {
                let mut doc = doc;
                doc.remove("_id");
                if let Ok(val) = serde_json::to_value(&doc) {
                    last_msgs.push(val);
                }
            }
        }
        last_msgs.reverse(); // chronological order

        // Batch-fetch reactions for these messages
        let event_ids: Vec<String> = last_msgs
            .iter()
            .filter_map(|m| m.get("event_id").and_then(|v| v.as_str()).map(String::from))
            .collect();
        let reactions_map = get_reactions_for_events(&state, &event_ids).await;
        for msg in last_msgs.iter_mut() {
            if let Some(eid) = msg.get("event_id").and_then(|v| v.as_str()) {
                if let Some(reactions) = reactions_map.get(eid) {
                    if !reactions.is_empty() {
                        msg.as_object_mut().unwrap().insert(
                            "reactions".to_string(),
                            serde_json::to_value(reactions).unwrap(),
                        );
                    }
                }
            }
        }

        // Build a map of display_names for members in this room
        let mut member_display_names: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        for mid in members {
            if let Ok(Some(u)) = users_coll.find_one(doc! { "_id": mid }).await {
                if !u.display_name.is_empty() {
                    member_display_names.insert(mid.clone(), u.display_name);
                }
            }
        }

        let member_events: Vec<Value> = members
            .iter()
            .map(|mid| {
                let display = member_display_names.get(mid)
                    .map(|s| s.as_str())
                    .unwrap_or_else(|| {
                        mid.split(':').next().unwrap_or(mid).trim_start_matches('@')
                    });
                let mut role = room_roles
                    .get(room_id)
                    .and_then(|m| m.get(mid))
                    .map(|r| r.as_str())
                    .unwrap_or("member");
                // Legacy fallback: creator is always owner
                if role == "member" && *mid == room_data.creator {
                    role = "owner";
                }
                json!({
                    "type": "m.room.member",
                    "state_key": mid,
                    "content": {
                        "membership": "join",
                        "displayname": display,
                        "role": role
                    },
                    "sender": mid
                })
            })
            .collect();

        // For DMs, show the other person's name
        let display_name = if room_data.is_dm {
            let other = members.iter().find(|m| *m != &user_id);
            if let Some(other_id) = other {
                let other_display = other_id
                    .split(':')
                    .next()
                    .unwrap_or(other_id)
                    .trim_start_matches('@');
                format!("DM with {}", other_display)
            } else {
                room_data.name.clone()
            }
        } else {
            room_data.name.clone()
        };

        let mut state_events = vec![
            json!({
                "type": "m.room.name",
                "state_key": "",
                "content": {"name": display_name},
                "sender": room_data.creator
            }),
            json!({
                "type": "m.room.topic",
                "state_key": "",
                "content": {"topic": room_data.topic},
                "sender": room_data.creator
            }),
            json!({
                "type": "m.room.direct",
                "state_key": "",
                "content": {"is_direct": room_data.is_dm},
                "sender": room_data.creator
            }),
            json!({
                "type": "m.room.tags",
                "state_key": "",
                "content": {"tags": room_data.tags},
                "sender": room_data.creator
            }),
            json!({
                "type": "m.room.icon",
                "state_key": "",
                "content": {"icon_url": room_data.icon_url},
                "sender": room_data.creator
            }),
            json!({
                "type": "m.room.custom_emojis",
                "state_key": "",
                "content": {"custom_emojis": room_data.custom_emojis},
                "sender": room_data.creator
            }),
            json!({
                "type": "m.room.emoji_aliases",
                "state_key": "",
                "content": {"emoji_aliases": room_data.emoji_aliases},
                "sender": room_data.creator
            }),
            json!({
                "type": "m.room.name_colors",
                "state_key": "",
                "content": {
                    "owner_name_color": room_data.owner_name_color,
                    "mod_name_color": room_data.mod_name_color
                },
                "sender": room_data.creator
            }),
            json!({
                "type": "m.room.unlisted",
                "state_key": "",
                "content": {"unlisted": room_data.unlisted},
                "sender": room_data.creator
            }),
            json!({
                "type": "m.room.has_password",
                "state_key": "",
                "content": {"has_password": !room_data.password_hash.is_empty()},
                "sender": room_data.creator
            }),
            json!({
                "type": "m.room.type",
                "state_key": "",
                "content": {"room_type": if room_data.room_type.is_empty() { "text" } else { &room_data.room_type }},
                "sender": room_data.creator
            }),
        ];
        if room_data.is_dm {
            state_events.push(json!({
                "type": "m.room.direct",
                "state_key": "",
                "content": {"is_direct": true},
                "sender": room_data.creator
            }));
        }
        state_events.extend(member_events);

        joined_rooms_data.insert(
            room_id.clone(),
            json!({
                "state": {"events": state_events},
                "timeline": {
                    "events": last_msgs,
                    "limited": false,
                    "prev_batch": "t0"
                }
            }),
        );
    }

    let ts = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_secs();

    Ok(Json(json!({
        "next_batch": format!("s{}", ts),
        "rooms": {
            "join": Value::Object(joined_rooms_data)
        }
    })))
}
