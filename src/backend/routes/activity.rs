//! Cross-room activity for the Activity page: message statistics for the
//! caller, and a feed of the system events from the rooms they have joined.
//!
//! Both used to be derived client-side from the sync window, which is capped,
//! so the "totals" it showed silently under-counted. These read the message
//! collection directly and are bounded by an explicit time window instead.

use super::super::{
    helpers::{
        error_response, extract_token, get_allowed_channel_ids, get_user_from_token, now_millis,
    },
    state::AppState,
};
use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::Json,
};
use futures_util::TryStreamExt;
use mongodb::bson::{doc, Bson, Document};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

const STATS_WINDOW_DAYS: i64 = 30;
const DAY_MS: i64 = 86_400_000;
const TOP_N: i64 = 5;
const FEED_DEFAULT_LIMIT: i64 = 25;
const FEED_MAX_LIMIT: i64 = 100;
/// +/- 14h covers every real UTC offset.
const MAX_TZ_OFFSET_MINUTES: i64 = 14 * 60;

/// Timestamps have been written as both i64 and i32 over the project's life.
fn doc_ts(d: &Document, key: &str) -> i64 {
    d.get_i64(key)
        .or_else(|_| d.get_i32(key).map(i64::from))
        .unwrap_or(0)
}

/// Every room the caller is in, paired with the channels they may read.
/// A `None` channel list means unrestricted, matching `get_allowed_channel_ids`.
async fn visible_scope(state: &AppState, user_id: &str) -> Vec<(String, Option<Vec<String>>)> {
    let joined: Vec<String> = {
        let rm = state.room_members.read().await;
        rm.iter()
            .filter(|(_, members)| members.iter().any(|m| m == user_id))
            .map(|(room_id, _)| room_id.clone())
            .collect()
    };

    let mut scope = Vec::with_capacity(joined.len());
    for room_id in joined {
        let allowed = get_allowed_channel_ids(state, &room_id, user_id).await;
        scope.push((room_id, allowed));
    }
    scope
}

/// A match clause spanning every room and channel the caller can read.
///
/// `None` when they are in no rooms at all: an empty `$or` is a Mongo error,
/// and the callers answer with an empty result instead.
fn scope_filter(scope: &[(String, Option<Vec<String>>)]) -> Option<Document> {
    if scope.is_empty() {
        return None;
    }
    let clauses: Vec<Document> = scope
        .iter()
        .map(|(room_id, allowed)| match allowed {
            // Even a restricted member sees the messages that carry no channel
            // at all — DMs, and rooms that predate channels.
            Some(ids) => doc! {
                "room_id": room_id,
                "$or": [
                    { "channel_id": { "$in": ids } },
                    { "channel_id": { "$exists": false } },
                ],
            },
            None => doc! { "room_id": room_id },
        })
        .collect();
    Some(doc! { "$or": clauses })
}

fn empty_stats() -> Value {
    json!({
        "window_days": STATS_WINDOW_DAYS,
        "total": 0,
        "mine": 0,
        "daily": [],
        "hourly": vec![0; 24],
        "top_people": [],
        "top_rooms": [],
    })
}

/// Message counts over the last 30 days across everything the caller can read.
///
/// One aggregation with a `$facet`, so the day series, hour histogram, leader
/// boards and totals all come from a single pass.
pub(crate) async fn activity_stats(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<StatsQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let scope = visible_scope(&state, &user_id).await;
    let Some(scope_doc) = scope_filter(&scope) else {
        return Ok(Json(empty_stats()));
    };

    // Shifting the timestamp and then bucketing in UTC gives local-time buckets
    // without depending on a timezone database being present in the server.
    let tz_shift_ms = query
        .tz_offset
        .unwrap_or(0)
        .clamp(-MAX_TZ_OFFSET_MINUTES, MAX_TZ_OFFSET_MINUTES)
        * 60_000;
    let local_date = doc! { "$toDate": { "$add": ["$origin_server_ts", tz_shift_ms] } };

    let since = now_millis() - STATS_WINDOW_DAYS * DAY_MS;
    let mut match_doc = scope_doc;
    match_doc.insert("type", "m.room.message");
    match_doc.insert("origin_server_ts", doc! { "$gte": since });
    match_doc.insert("content.msgtype", doc! { "$ne": "m.system" });

    let pipeline = vec![
        doc! { "$match": match_doc },
        doc! { "$facet": {
            "daily": [
                { "$group": {
                    "_id": { "$dateToString": {
                        "format": "%Y-%m-%d",
                        "date": &local_date,
                    }},
                    "count": { "$sum": 1 },
                }},
                { "$sort": { "_id": 1 } },
            ],
            "hourly": [
                { "$group": {
                    "_id": { "$hour": { "date": &local_date } },
                    "count": { "$sum": 1 },
                }},
            ],
            "people": [
                { "$match": { "$and": [
                    { "sender": { "$ne": &user_id } },
                    { "sender": { "$not": { "$regex": "^webhook:" } } },
                ]}},
                { "$group": { "_id": "$sender", "count": { "$sum": 1 } } },
                { "$sort": { "count": -1 } },
                { "$limit": TOP_N },
            ],
            "rooms": [
                { "$group": { "_id": "$room_id", "count": { "$sum": 1 } } },
                { "$sort": { "count": -1 } },
                { "$limit": TOP_N },
            ],
            "totals": [
                { "$group": {
                    "_id": Bson::Null,
                    "total": { "$sum": 1 },
                    "mine": { "$sum": { "$cond": [{ "$eq": ["$sender", &user_id] }, 1, 0] } },
                }},
            ],
        }},
    ];

    let coll = state.db.collection::<Document>("messages");
    let Ok(mut cursor) = coll.aggregate(pipeline).await else {
        return Ok(Json(empty_stats()));
    };
    let Ok(Some(facets)) = cursor.try_next().await else {
        return Ok(Json(empty_stats()));
    };

    // A $facet always returns one document whose fields are the sub-pipelines.
    let bucket = |name: &str| -> Vec<Document> {
        facets
            .get_array(name)
            .map(|arr| {
                arr.iter()
                    .filter_map(|b| b.as_document().cloned())
                    .collect()
            })
            .unwrap_or_default()
    };

    let daily: Vec<Value> = bucket("daily")
        .iter()
        .map(|d| {
            json!({
                "date": d.get_str("_id").unwrap_or(""),
                "count": doc_ts(d, "count"),
            })
        })
        .collect();

    // Absent hours must still read as zero, so start from a full day.
    let mut hourly = vec![0i64; 24];
    for row in bucket("hourly") {
        let hour = doc_ts(&row, "_id");
        if (0..24).contains(&hour) {
            hourly[hour as usize] = doc_ts(&row, "count");
        }
    }

    let top_people: Vec<Value> = bucket("people")
        .iter()
        .map(|d| json!({ "user_id": d.get_str("_id").unwrap_or(""), "count": doc_ts(d, "count") }))
        .collect();
    let top_rooms: Vec<Value> = bucket("rooms")
        .iter()
        .map(|d| json!({ "room_id": d.get_str("_id").unwrap_or(""), "count": doc_ts(d, "count") }))
        .collect();

    let totals = bucket("totals");
    let (total, mine) = totals
        .first()
        .map(|d| (doc_ts(d, "total"), doc_ts(d, "mine")))
        .unwrap_or((0, 0));

    Ok(Json(json!({
        "window_days": STATS_WINDOW_DAYS,
        "total": total,
        "mine": mine,
        "daily": daily,
        "hourly": hourly,
        "top_people": top_people,
        "top_rooms": top_rooms,
    })))
}

#[derive(Deserialize)]
pub(crate) struct FeedQuery {
    limit: Option<i64>,
}

#[derive(Deserialize)]
pub(crate) struct StatsQuery {
    /// Minutes east of UTC, as the caller's browser reports it. Day and hour
    /// buckets are grouped in the caller's local time, not the server's.
    tz_offset: Option<i64>,
}

/// The most recent system events — joins, kicks, ownership changes and the
/// like — across every room the caller can read. They are stored as ordinary
/// messages carrying `content.msgtype == "m.system"`.
pub(crate) async fn activity_feed(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<FeedQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let scope = visible_scope(&state, &user_id).await;
    let Some(scope_doc) = scope_filter(&scope) else {
        return Ok(Json(json!({ "events": [] })));
    };

    let limit = query
        .limit
        .unwrap_or(FEED_DEFAULT_LIMIT)
        .clamp(1, FEED_MAX_LIMIT);

    let mut filter = scope_doc;
    filter.insert("type", "m.room.message");
    filter.insert("content.msgtype", "m.system");

    let coll = state.db.collection::<Document>("messages");
    let Ok(mut cursor) = coll
        .find(filter)
        .sort(doc! { "origin_server_ts": -1 })
        .limit(limit)
        .await
    else {
        return Ok(Json(json!({ "events": [] })));
    };

    let mut events: Vec<Value> = Vec::new();
    while let Ok(Some(d)) = cursor.try_next().await {
        let body = d
            .get_document("content")
            .ok()
            .and_then(|c| c.get_str("body").ok())
            .unwrap_or("");
        events.push(json!({
            "event_id": d.get_str("event_id").unwrap_or(""),
            "room_id": d.get_str("room_id").unwrap_or(""),
            "channel_id": d.get_str("channel_id").unwrap_or(""),
            "sender": d.get_str("sender").unwrap_or(""),
            "body": body,
            "ts": doc_ts(&d, "origin_server_ts"),
        }));
    }

    Ok(Json(json!({ "events": events })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_filter_is_none_without_rooms() {
        // An empty $or is a Mongo error, so callers need this signal.
        assert!(scope_filter(&[]).is_none());
    }

    #[test]
    fn unrestricted_rooms_match_on_room_alone() {
        let scope = vec![("!room:h".to_string(), None)];
        let filter = scope_filter(&scope).expect("one room");
        let clauses = filter.get_array("$or").expect("$or");
        assert_eq!(clauses.len(), 1);
        let clause = clauses[0].as_document().expect("document");
        assert_eq!(clause.get_str("room_id").unwrap(), "!room:h");
        assert!(clause.get("$or").is_none());
    }

    #[test]
    fn restricted_rooms_keep_channelless_messages() {
        // DMs and pre-channel rooms carry no channel_id; a restricted member
        // must still see those rather than losing them to the $in.
        let scope = vec![("!room:h".to_string(), Some(vec!["#a".to_string()]))];
        let filter = scope_filter(&scope).expect("one room");
        let clause = filter.get_array("$or").unwrap()[0]
            .as_document()
            .expect("document");
        let inner = clause.get_array("$or").expect("channel clause");
        assert_eq!(inner.len(), 2);
        assert!(inner[1]
            .as_document()
            .unwrap()
            .get_document("channel_id")
            .unwrap()
            .contains_key("$exists"));
    }

    #[test]
    fn doc_ts_reads_both_integer_widths() {
        let wide = doc! { "ts": 1_700_000_000_000i64 };
        let narrow = doc! { "ts": 42i32 };
        assert_eq!(doc_ts(&wide, "ts"), 1_700_000_000_000);
        assert_eq!(doc_ts(&narrow, "ts"), 42);
        assert_eq!(doc_ts(&wide, "missing"), 0);
    }
}
