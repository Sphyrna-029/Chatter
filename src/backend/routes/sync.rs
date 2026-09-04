use super::super::{
    dto::SyncQuery,
    helpers::{
        error_response, extract_token, get_allowed_channel_ids, get_reactions_for_events,
        get_user_from_token,
    },
    state::{
        AppState, ChannelRecord, DmRoomRecord, DmStreakRecord, RoomMemberRecord, RoomRecord,
        UserRecord,
    },
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

        // Compute which channels this user may see (None = privileged, sees all).
        // For DMs there are no channels so no restriction is needed.
        let allowed_channel_ids: Option<Vec<String>> = if room_data.is_dm {
            None
        } else {
            get_allowed_channel_ids(&state, room_id, &user_id).await
        };

        // Build message filter restricted to visible channels
        let msg_filter = if let Some(ref ids) = allowed_channel_ids {
            let bson_ids: Vec<mongodb::bson::Bson> = ids
                .iter()
                .map(|s| mongodb::bson::Bson::String(s.clone()))
                .collect();
            doc! { "room_id": room_id, "$or": [
                { "channel_id": { "$in": bson_ids } },
                { "channel_id": { "$exists": false } }
            ]}
        } else {
            doc! { "room_id": room_id }
        };

        // Fetch last 10 messages from MongoDB
        let mut last_msgs: Vec<Value> = Vec::new();
        if let Ok(mut cursor) = msg_coll
            .find(msg_filter)
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
        let mut member_display_names: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();
        for mid in members {
            if let Ok(Some(u)) = users_coll.find_one(doc! { "_id": mid }).await {
                if !u.display_name.is_empty() {
                    member_display_names.insert(mid.clone(), u.display_name);
                }
            }
        }

        // Fetch joined_at timestamps from MongoDB
        let member_records_coll = state.db.collection::<RoomMemberRecord>("room_members");
        let mut joined_at_map: std::collections::HashMap<String, i64> =
            std::collections::HashMap::new();
        if let Ok(mut cursor) = member_records_coll.find(doc! { "room_id": room_id }).await {
            while let Ok(Some(rec)) = cursor.try_next().await {
                if rec.joined_at != 0 {
                    joined_at_map.insert(rec.user_id, rec.joined_at);
                }
            }
        }

        let member_events: Vec<Value> = members
            .iter()
            .map(|mid| {
                let display = member_display_names
                    .get(mid)
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
                let mut content = json!({
                    "membership": "join",
                    "displayname": display,
                    "role": role
                });
                if let Some(&ts) = joined_at_map.get(mid) {
                    content["joined_at"] = json!(ts);
                }
                json!({
                    "type": "m.room.member",
                    "state_key": mid,
                    "content": content,
                    "sender": mid
                })
            })
            .collect();

        // For DMs, show all other members' names unless a custom name has been set
        let display_name = if room_data.is_dm && !room_data.dm_name_override {
            let others: Vec<String> = members
                .iter()
                .filter(|m| **m != user_id)
                .map(|id| {
                    id.split(':')
                        .next()
                        .unwrap_or(id)
                        .trim_start_matches('@')
                        .to_string()
                })
                .collect();
            if others.is_empty() {
                room_data.name.clone()
            } else {
                format!("DM with {}", others.join(", "))
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
            json!({
                "type": "m.room.read_only",
                "state_key": "",
                "content": {"read_only": room_data.read_only},
                "sender": room_data.creator
            }),
            json!({
                "type": "m.room.banner",
                "state_key": "",
                "content": {"banner_url": room_data.banner_url},
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

            // Include streak data for DM rooms
            let dm_rooms_coll = state.db.collection::<DmRoomRecord>("dm_rooms");
            if let Ok(Some(dm_record)) = dm_rooms_coll.find_one(doc! { "room_id": room_id }).await {
                let streak_coll = state.db.collection::<DmStreakRecord>("dm_streaks");
                if let Ok(Some(streak)) = streak_coll
                    .find_one(doc! { "_id": &dm_record.user_pair })
                    .await
                {
                    state_events.push(json!({
                        "type": "m.room.dm_streak",
                        "state_key": "",
                        "content": {
                            "streak_count": streak.streak_count,
                            "last_message_ts": streak.last_message_ts,
                        },
                        "sender": room_data.creator
                    }));
                }
            }
        }

        // Fetch channels for non-DM rooms
        let mut channels_data: Vec<Value> = Vec::new();
        if !room_data.is_dm {
            let channels_coll = state.db.collection::<ChannelRecord>("channels");
            if let Ok(mut ch_cursor) = channels_coll
                .find(doc! { "room_id": room_id })
                .sort(doc! { "position": 1, "created_at": 1 })
                .await
            {
                while let Ok(Some(ch)) = ch_cursor.try_next().await {
                    // Only expose channels the user is allowed to see
                    let visible = match &allowed_channel_ids {
                        None => true, // privileged: sees all
                        Some(ids) => ids.contains(&ch.channel_id),
                    };
                    if !visible {
                        continue;
                    }
                    channels_data.push(json!({
                        "channel_id": ch.channel_id,
                        "name": ch.name,
                        "channel_type": ch.channel_type,
                        "topic": ch.topic,
                        "position": ch.position,
                        "category_id": ch.category_id,
                        "read_only": ch.read_only,
                    }));
                }
            }
            state_events.push(json!({
                "type": "m.room.channels",
                "state_key": "",
                "content": { "channels": channels_data },
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
