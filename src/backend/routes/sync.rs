use super::super::{
    dto::SyncQuery,
    helpers::{
        error_response, extract_token, get_allowed_channel_ids, get_reactions_for_events,
        get_user_from_token, room_member_entries,
    },
    state::{AppState, ChannelRecord, DmRoomRecord, DmStreakRecord, RoomRecord, UserRecord},
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

    // Snapshot the membership cache and let go of the guard before any database
    // work starts. Held across the loop below — which is hundreds of round
    // trips for an account in a few busy rooms — a read guard here is enough to
    // stall the whole server: tokio's RwLock is write-preferring, so one join
    // arriving mid-sync queues a writer behind this guard, and every later
    // reader then queues behind that writer. Sending a room list built a few
    // milliseconds ago is the lesser problem by far.
    let my_rooms: Vec<(String, Vec<String>)> = {
        let rm = state.room_members.read().await;
        rm.iter()
            .filter(|(_, members)| members.contains(&user_id))
            .map(|(room_id, members)| (room_id.clone(), members.clone()))
            .collect()
    };

    let rooms_coll = state.db.collection::<RoomRecord>("rooms");
    let msg_coll = state.db.collection::<mongodb::bson::Document>("messages");

    let mut joined_rooms_data = serde_json::Map::new();

    for (room_id, members) in &my_rooms {
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

        // Names, roles and join times for the whole room, from the same
        // helper `/api/rooms/{id}/members` uses. Two queries for the room
        // rather than one per person, which is what this was.
        let member_events: Vec<Value> =
            room_member_entries(&state, room_id, members, &room_data.creator)
                .await
                .into_iter()
                .map(|e| {
                    let mut content = json!({
                        "membership": "join",
                        "displayname": e.display_name,
                        "role": e.role
                    });
                    if let Some(ts) = e.joined_at {
                        content["joined_at"] = json!(ts);
                    }
                    json!({
                        "type": "m.room.member",
                        "state_key": e.user_id,
                        "content": content,
                        "sender": e.user_id
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
            json!({
                "type": "m.room.sounds",
                "state_key": "",
                "content": {
                    "sounds": room_data.sounds,
                    "entrance_sounds_enabled": room_data.entrance_sounds_enabled,
                },
                "sender": room_data.creator
            }),
            json!({
                "type": "m.room.theme",
                "state_key": "",
                "content": {"suggested_theme": room_data.suggested_theme},
                "sender": room_data.creator
            }),
        ];
        if room_data.is_dm {
            // Who the DM is *with*, so the client can show their face without
            // asking. The room's name carries a display name and nothing else,
            // and members are only loaded for the room currently open — a list
            // of every conversation needs the ids up front. Taken from the
            // membership cache, so this costs no query.
            // `members` is the snapshot this loop is already iterating, so
            // this costs no lock and no query.
            let others: Vec<String> = members.iter().filter(|m| **m != user_id).cloned().collect();
            // Their avatar travels with the id. Presence — the client's usual
            // source for a face — is only loaded for the room being viewed, so
            // a list of every conversation would otherwise show initials until
            // each one had been opened once.
            let mut dm_avatars = serde_json::Map::new();
            if !others.is_empty() {
                let users_coll = state.db.collection::<UserRecord>("users");
                if let Ok(mut cursor) = users_coll.find(doc! { "_id": { "$in": &others } }).await {
                    while let Ok(Some(u)) = cursor.try_next().await {
                        if !u.avatar_url.is_empty() {
                            dm_avatars.insert(u.user_id.clone(), json!(u.avatar_url));
                        }
                    }
                }
            }
            // A DM's call is keyed by the room id, so its occupancy is one
            // lookup. Seeded here because live join and leave events only tell
            // a client about calls that start while it is running.
            let dm_voice_count = {
                let vc = state.voice_channels.read().await;
                vc.get(room_id).map(|m| m.len()).unwrap_or(0)
            };
            state_events.push(json!({
                "type": "m.room.direct",
                "state_key": "",
                "content": {
                    "is_direct": true,
                    "dm_user_ids": others,
                    "dm_avatars": Value::Object(dm_avatars),
                    "dm_voice_count": dm_voice_count,
                },
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
