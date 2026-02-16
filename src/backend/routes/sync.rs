use super::super::{
    dto::SyncQuery,
    helpers::{error_response, extract_token, get_user_from_token},
    state::AppState,
};
use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::Json,
};
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
        .await
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let rm = state.room_members.read().await;
    let rooms = state.rooms.read().await;
    let msgs = state.messages.read().await;

    let mut joined_rooms_data = serde_json::Map::new();

    for (room_id, members) in rm.iter() {
        if !members.contains(&user_id) {
            continue;
        }

        let room_data = match rooms.get(room_id) {
            Some(r) => r,
            None => continue,
        };

        let room_msgs = msgs.get(room_id).cloned().unwrap_or_default();
        let last_msgs: Vec<Value> = room_msgs
            .into_iter()
            .rev()
            .take(10)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();

        let member_events: Vec<Value> = members
            .iter()
            .map(|mid| {
                let display = mid.split(':').next().unwrap_or(mid).trim_start_matches('@');
                json!({
                    "type": "m.room.member",
                    "state_key": mid,
                    "content": {
                        "membership": "join",
                        "displayname": display
                    },
                    "sender": mid
                })
            })
            .collect();

        // For DMs, show the other person's name relative to the viewer
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
