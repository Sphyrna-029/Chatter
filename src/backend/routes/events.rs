//! Scheduled events in a room: who is meeting, when, and who said they would
//! come.
//!
//! Times cross the wire as epoch milliseconds and are rendered in the viewer's
//! own zone. A room whose members are in three countries has no other way to
//! agree on when a thing starts.

use super::super::{
    dto::{CreateEventRequest, EventsQuery, RsvpRequest, UpdateEventRequest},
    helpers::{
        broadcast_to_room, effective_permissions, error_response, extract_token, generate_id,
        get_allowed_channel_ids, get_user_from_token, now_millis, send_to_user,
    },
    push::{spawn_event_reminder_push, EventReminderNotification},
    state::{AppState, EventRecord, EventRsvpRecord, RoomRecord},
};
use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::Json,
};
use futures_util::TryStreamExt;
use mongodb::bson::{doc, Document};
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Arc};

/// Long enough for "Thursday board game night (bring your own dice)", short
/// enough that a title still fits one line in the panel.
const MAX_NAME_LEN: usize = 120;
const MAX_DESCRIPTION_LEN: usize = 4000;
const MAX_LOCATION_LEN: usize = 200;
/// A room with more scheduled events than this is not using a list any more.
const MAX_EVENTS_PER_ROOM: u64 = 200;
/// How long after it ends an event stays in the default listing. An event that
/// finished an hour ago is still the thing people are asking about.
const RECENTLY_ENDED_MS: i64 = 6 * 60 * 60 * 1000;
/// Nobody schedules anything a century out; a date that far off is a client
/// that has confused seconds for milliseconds.
const MAX_FUTURE_MS: i64 = 100 * 365 * 24 * 60 * 60 * 1000;

const STATUSES: [&str; 3] = ["going", "maybe", "declined"];

/// The caller, once confirmed to be a member of the room.
async fn require_member(
    state: &AppState,
    headers: &HeaderMap,
    room_id: &str,
) -> Result<String, (StatusCode, Json<Value>)> {
    let token = extract_token(headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

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
    Ok(user_id)
}

/// An event may only be pinned to a channel the person scheduling it can
/// actually see, or the listing would name a channel they cannot open.
async fn check_channel(
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
                "You do not have access to that channel",
            ));
        }
    }
    Ok(())
}

/// Shared validation for a create and for the fields a patch touches.
///
/// `starts_at` is deliberately allowed to be in the past: an event is often
/// entered while it is already running, and refusing that only teaches people
/// to lie about the time.
fn validate(
    name: &str,
    description: &str,
    location: &str,
    starts_at: i64,
    ends_at: i64,
) -> Result<(), (StatusCode, Json<Value>)> {
    let name = name.trim();
    if name.is_empty() {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "An event needs a name",
        ));
    }
    if name.chars().count() > MAX_NAME_LEN {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "That name is too long",
        ));
    }
    if description.chars().count() > MAX_DESCRIPTION_LEN {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "That description is too long",
        ));
    }
    if location.chars().count() > MAX_LOCATION_LEN {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "That location is too long",
        ));
    }
    if starts_at <= 0 {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "An event needs a start time",
        ));
    }
    if starts_at > now_millis() + MAX_FUTURE_MS {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "That start time is not a real date",
        ));
    }
    // 0 means open-ended, which is a legitimate answer, not a missing one.
    if ends_at != 0 && ends_at <= starts_at {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "An event cannot end before it starts",
        ));
    }
    Ok(())
}

/// The RSVP tallies and the caller's own answer, for a batch of events.
///
/// One query for the whole page rather than one per event: a room with twenty
/// events would otherwise cost twenty round trips to draw a list.
async fn rsvp_summary(
    state: &AppState,
    room_id: &str,
    event_ids: &[String],
    me: &str,
) -> HashMap<String, (HashMap<String, Vec<String>>, String)> {
    let mut out: HashMap<String, (HashMap<String, Vec<String>>, String)> = HashMap::new();
    if event_ids.is_empty() {
        return out;
    }
    let coll = state.db.collection::<EventRsvpRecord>("event_rsvps");
    let Ok(mut cursor) = coll
        .find(doc! { "room_id": room_id, "event_id": { "$in": event_ids } })
        .await
    else {
        return out;
    };
    while let Ok(Some(r)) = cursor.try_next().await {
        let entry = out
            .entry(r.event_id.clone())
            .or_insert_with(|| (HashMap::new(), String::new()));
        entry
            .0
            .entry(r.status.clone())
            .or_default()
            .push(r.user_id.clone());
        if r.user_id == me {
            entry.1 = r.status.clone();
        }
    }
    out
}

/// One event in the shape the client renders, with its tallies folded in.
fn event_json(
    record: &EventRecord,
    by_status: &HashMap<String, Vec<String>>,
    my_rsvp: &str,
) -> Value {
    // The panel shows a handful of faces per event and a count; sending every
    // attendee id for every event would be most of the payload for something
    // nobody reads until they open one.
    let going: &[String] = by_status.get("going").map(|v| v.as_slice()).unwrap_or(&[]);
    let maybe: &[String] = by_status.get("maybe").map(|v| v.as_slice()).unwrap_or(&[]);
    json!({
        "event_id": record.event_id,
        "room_id": record.room_id,
        "creator": record.creator,
        "name": record.name,
        "description": record.description,
        "location": record.location,
        "channel_id": record.channel_id,
        "starts_at": record.starts_at,
        "ends_at": record.ends_at,
        "cover_url": record.cover_url,
        "created_at": record.created_at,
        "updated_at": record.updated_at,
        "cancelled": record.cancelled,
        "going_count": going.len(),
        "maybe_count": maybe.len(),
        "going_preview": going.iter().take(8).collect::<Vec<_>>(),
        "my_rsvp": my_rsvp,
    })
}

/// Re-read one event and announce it, so every open panel in the room agrees
/// without having to re-list.
async fn broadcast_event(state: &AppState, room_id: &str, event_id: &str, kind: &str) {
    let coll = state.db.collection::<EventRecord>("events");
    let Some(record) = coll
        .find_one(doc! { "_id": event_id, "room_id": room_id })
        .await
        .ok()
        .flatten()
    else {
        return;
    };
    let summary = rsvp_summary(state, room_id, &[event_id.to_string()], "").await;
    let empty = (HashMap::new(), String::new());
    let (by_status, _) = summary.get(event_id).unwrap_or(&empty);
    // `my_rsvp` is deliberately empty here: one broadcast reaches everyone, and
    // each client already knows its own answer. Sending one person's would tell
    // the rest of the room something false.
    let event = json!({
        "type": kind,
        "room_id": room_id,
        "event": event_json(&record, by_status, ""),
    });
    broadcast_to_room(state, room_id, &event).await;
}

/// GET /api/rooms/{room_id}/events?include_past=
///
/// Upcoming first, soonest first. Past events are only included when asked
/// for, and then newest first — looking back, the last thing that happened is
/// the one you want.
pub(crate) async fn list_events(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<EventsQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let user_id = require_member(&state, &headers, &room_id).await?;
    let include_past = query.include_past.unwrap_or(false);

    let coll = state.db.collection::<EventRecord>("events");
    let mut cursor = coll
        .find(doc! { "room_id": &room_id })
        .sort(doc! { "starts_at": 1 })
        .limit(MAX_EVENTS_PER_ROOM as i64)
        .await
        .map_err(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "DB query failed"))?;

    let mut records: Vec<EventRecord> = Vec::new();
    while let Ok(Some(r)) = cursor.try_next().await {
        records.push(r);
    }

    let now = now_millis();
    // An event with no end time is over once its start is well behind us;
    // otherwise an open-ended event would head the list forever.
    let is_past = |e: &EventRecord| {
        let over_at = if e.ends_at > 0 {
            e.ends_at
        } else {
            e.starts_at
        };
        over_at + RECENTLY_ENDED_MS < now
    };

    let (past, upcoming): (Vec<EventRecord>, Vec<EventRecord>) =
        records.into_iter().partition(is_past);

    let mut shown = upcoming;
    if include_past {
        let mut past = past;
        past.sort_by(|a, b| b.starts_at.cmp(&a.starts_at));
        shown.extend(past);
    }

    let ids: Vec<String> = shown.iter().map(|e| e.event_id.clone()).collect();
    let summary = rsvp_summary(&state, &room_id, &ids, &user_id).await;
    let empty = (HashMap::new(), String::new());

    let events: Vec<Value> = shown
        .iter()
        .map(|record| {
            let (by_status, mine) = summary.get(&record.event_id).unwrap_or(&empty);
            event_json(record, by_status, mine)
        })
        .collect();

    Ok(Json(json!({ "events": events })))
}

/// POST /api/rooms/{room_id}/events
pub(crate) async fn create_event(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
    Json(req): Json<CreateEventRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let user_id = require_member(&state, &headers, &room_id).await?;

    if !effective_permissions(&state, &room_id, &user_id)
        .await
        .manage_events
    {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "You do not have permission to create events in this room",
        ));
    }

    let name = req.name.trim().to_string();
    let description = req.description.unwrap_or_default().trim().to_string();
    let location = req.location.unwrap_or_default().trim().to_string();
    let channel_id = req.channel_id.unwrap_or_default();
    let ends_at = req.ends_at.unwrap_or(0);
    validate(&name, &description, &location, req.starts_at, ends_at)?;
    check_channel(&state, &room_id, &user_id, &channel_id).await?;

    let coll = state.db.collection::<EventRecord>("events");
    let existing = coll
        .count_documents(doc! { "room_id": &room_id })
        .await
        .unwrap_or(0);
    if existing >= MAX_EVENTS_PER_ROOM {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "This room already has as many events as it can hold",
        ));
    }

    let now = now_millis();
    let record = EventRecord {
        event_id: generate_id("evt"),
        room_id: room_id.clone(),
        creator: user_id.clone(),
        name,
        description,
        location,
        channel_id,
        starts_at: req.starts_at,
        ends_at,
        cover_url: req.cover_url.unwrap_or_default(),
        created_at: now,
        updated_at: now,
        cancelled: false,
        reminded_at: 0,
    };

    coll.insert_one(&record)
        .await
        .map_err(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "Could not save event"))?;

    // Whoever schedules something is coming to it. Saying so saves them a
    // click and means an event is never listed with nobody attending.
    let rsvps = state.db.collection::<EventRsvpRecord>("event_rsvps");
    let _ = rsvps
        .insert_one(&EventRsvpRecord {
            id: format!("{}:{}", record.event_id, user_id),
            event_id: record.event_id.clone(),
            room_id: room_id.clone(),
            user_id: user_id.clone(),
            status: "going".to_string(),
            responded_at: now,
        })
        .await;

    broadcast_event(&state, &room_id, &record.event_id, "m.room.event_created").await;

    let by_status: HashMap<String, Vec<String>> =
        HashMap::from([("going".to_string(), vec![user_id.clone()])]);
    Ok(Json(
        json!({ "event": event_json(&record, &by_status, "going") }),
    ))
}

/// PATCH /api/rooms/{room_id}/events/{event_id}
///
/// The person who scheduled it can always edit it; anyone else needs
/// `manage_events`, the same permission that let them schedule one.
pub(crate) async fn update_event(
    State(state): State<Arc<AppState>>,
    Path((room_id, event_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(req): Json<UpdateEventRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let user_id = require_member(&state, &headers, &room_id).await?;

    let coll = state.db.collection::<EventRecord>("events");
    let record = coll
        .find_one(doc! { "_id": &event_id, "room_id": &room_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Event not found"))?;

    if record.creator != user_id
        && !effective_permissions(&state, &room_id, &user_id)
            .await
            .manage_events
    {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "You can only edit events you created",
        ));
    }

    let name = req.name.clone().unwrap_or_else(|| record.name.clone());
    let name = name.trim().to_string();
    let description = req
        .description
        .clone()
        .unwrap_or_else(|| record.description.clone());
    let description = description.trim().to_string();
    let location = req
        .location
        .clone()
        .unwrap_or_else(|| record.location.clone());
    let location = location.trim().to_string();
    let starts_at = req.starts_at.unwrap_or(record.starts_at);
    let ends_at = req.ends_at.unwrap_or(record.ends_at);
    validate(&name, &description, &location, starts_at, ends_at)?;

    let channel_id = req
        .channel_id
        .clone()
        .unwrap_or_else(|| record.channel_id.clone());
    check_channel(&state, &room_id, &user_id, &channel_id).await?;

    let mut set = Document::new();
    set.insert("name", &name);
    set.insert("description", &description);
    set.insert("location", &location);
    set.insert("channel_id", &channel_id);
    set.insert("starts_at", starts_at);
    set.insert("ends_at", ends_at);
    set.insert("updated_at", now_millis());
    // Moving an event re-arms its reminder — the one that may already have
    // gone out was about a time that is no longer when this happens.
    if starts_at != record.starts_at {
        set.insert("reminded_at", 0i64);
    }
    if let Some(cover) = req.cover_url.clone() {
        set.insert("cover_url", cover);
    }
    if let Some(cancelled) = req.cancelled {
        set.insert("cancelled", cancelled);
    }

    coll.update_one(
        doc! { "_id": &event_id, "room_id": &room_id },
        doc! { "$set": set },
    )
    .await
    .map_err(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "Could not save event"))?;

    broadcast_event(&state, &room_id, &event_id, "m.room.event_updated").await;
    Ok(Json(json!({ "updated": true })))
}

/// DELETE /api/rooms/{room_id}/events/{event_id}
///
/// Deletes outright, and takes the answers with it. Cancelling — which leaves
/// the event visible with the news on it — is a PATCH, and is what the client
/// offers first for an event people have already answered.
pub(crate) async fn delete_event(
    State(state): State<Arc<AppState>>,
    Path((room_id, event_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let user_id = require_member(&state, &headers, &room_id).await?;

    let coll = state.db.collection::<EventRecord>("events");
    let record = coll
        .find_one(doc! { "_id": &event_id, "room_id": &room_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Event not found"))?;

    if record.creator != user_id
        && !effective_permissions(&state, &room_id, &user_id)
            .await
            .manage_events
    {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "You can only delete events you created",
        ));
    }

    let _ = coll
        .delete_one(doc! { "_id": &event_id, "room_id": &room_id })
        .await;
    let _ = state
        .db
        .collection::<EventRsvpRecord>("event_rsvps")
        .delete_many(doc! { "event_id": &event_id })
        .await;

    let event = json!({
        "type": "m.room.event_deleted",
        "room_id": room_id,
        "event_id": event_id,
    });
    broadcast_to_room(&state, &room_id, &event).await;

    Ok(Json(json!({ "deleted": true })))
}

/// PUT /api/rooms/{room_id}/events/{event_id}/rsvp
///
/// Any member may answer. Answering again replaces the previous answer, and
/// answering with the answer you already gave withdraws it — the second press
/// of a toggle is how a list of buttons like this is expected to behave.
pub(crate) async fn set_rsvp(
    State(state): State<Arc<AppState>>,
    Path((room_id, event_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(req): Json<RsvpRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let user_id = require_member(&state, &headers, &room_id).await?;

    if !req.status.is_empty() && !STATUSES.contains(&req.status.as_str()) {
        return Err(error_response(StatusCode::BAD_REQUEST, "Unknown RSVP"));
    }

    let events = state.db.collection::<EventRecord>("events");
    let record = events
        .find_one(doc! { "_id": &event_id, "room_id": &room_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Event not found"))?;
    if record.cancelled {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "That event was cancelled",
        ));
    }

    let coll = state.db.collection::<EventRsvpRecord>("event_rsvps");
    let id = format!("{event_id}:{user_id}");

    if req.status.is_empty() {
        let _ = coll.delete_one(doc! { "_id": &id }).await;
    } else {
        let record = EventRsvpRecord {
            id: id.clone(),
            event_id: event_id.clone(),
            room_id: room_id.clone(),
            user_id: user_id.clone(),
            status: req.status.clone(),
            responded_at: now_millis(),
        };
        coll.replace_one(doc! { "_id": &id }, &record)
            .upsert(true)
            .await
            .map_err(|_| {
                error_response(StatusCode::INTERNAL_SERVER_ERROR, "Could not save RSVP")
            })?;
    }

    broadcast_event(&state, &room_id, &event_id, "m.room.event_rsvp").await;
    Ok(Json(json!({ "status": req.status })))
}

/// GET /api/rooms/{room_id}/events/{event_id}/rsvps
///
/// The full guest list, grouped. Only fetched when someone opens an event, so
/// the listing stays small for the common case of not caring.
pub(crate) async fn list_rsvps(
    State(state): State<Arc<AppState>>,
    Path((room_id, event_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    require_member(&state, &headers, &room_id).await?;

    let coll = state.db.collection::<EventRsvpRecord>("event_rsvps");
    let mut cursor = coll
        .find(doc! { "room_id": &room_id, "event_id": &event_id })
        .sort(doc! { "responded_at": 1 })
        .await
        .map_err(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "DB query failed"))?;

    let mut going: Vec<String> = Vec::new();
    let mut maybe: Vec<String> = Vec::new();
    let mut declined: Vec<String> = Vec::new();
    while let Ok(Some(r)) = cursor.try_next().await {
        match r.status.as_str() {
            "going" => going.push(r.user_id),
            "maybe" => maybe.push(r.user_id),
            "declined" => declined.push(r.user_id),
            _ => {}
        }
    }

    Ok(Json(
        json!({ "going": going, "maybe": maybe, "declined": declined }),
    ))
}

// ─── Reminders ───────────────────────────────────────────────────────────────

/// How far ahead the starting-soon reminder goes out. Long enough to finish
/// what you are doing and get there, short enough that you have not forgotten
/// again by the time it starts.
const REMINDER_LEAD_MS: i64 = 10 * 60 * 1000;
/// An event whose start is further behind us than this never gets a reminder.
/// Without it, a server that was down over the weekend would come back and
/// announce everything it slept through.
const REMINDER_GRACE_MS: i64 = 5 * 60 * 1000;
/// The scheduler's heartbeat. The reminder is a ten-minute promise, so half a
/// minute of slack in either direction is invisible.
const REMINDER_TICK_SECS: u64 = 30;

/// "starts in 10 minutes" / "is starting now" — the sentence the reminder
/// leads with, in both the push and the socket event, so they never disagree.
fn when_phrase(starts_at: i64, now: i64) -> String {
    let minutes = (starts_at - now + 59_999) / 60_000;
    if minutes <= 0 {
        return "is starting now".to_string();
    }
    if minutes == 1 {
        return "starts in a minute".to_string();
    }
    format!("starts in {minutes} minutes")
}

/// Everyone who said they would be at this event.
///
/// "Maybe" is included on purpose: someone who has not ruled it out is exactly
/// who a nudge is for. Only an explicit "can't make it" opts out.
async fn reminder_audience(state: &AppState, event_id: &str) -> Vec<String> {
    let coll = state.db.collection::<EventRsvpRecord>("event_rsvps");
    let Ok(mut cursor) = coll
        .find(doc! { "event_id": event_id, "status": { "$in": ["going", "maybe"] } })
        .await
    else {
        return Vec::new();
    };
    let mut out = Vec::new();
    while let Ok(Some(r)) = cursor.try_next().await {
        out.push(r.user_id);
    }
    out
}

/// Tell one event's audience that it is about to start.
async fn send_reminder(state: &Arc<AppState>, record: &EventRecord, now: i64) {
    let audience = reminder_audience(state, &record.event_id).await;
    if audience.is_empty() {
        return;
    }

    // Someone who has since left the room must not be reminded about its
    // events — they can no longer open the thing being announced.
    let audience: Vec<String> = {
        let rm = state.room_members.read().await;
        match rm.get(&record.room_id) {
            Some(members) => audience
                .into_iter()
                .filter(|uid| members.contains(uid))
                .collect(),
            None => return,
        }
    };
    if audience.is_empty() {
        return;
    }

    let when = when_phrase(record.starts_at, now);
    let room = state
        .db
        .collection::<RoomRecord>("rooms")
        .find_one(doc! { "_id": &record.room_id })
        .await
        .ok()
        .flatten();
    let room_name = room
        .as_ref()
        .map(|r| r.name.clone())
        .unwrap_or_else(|| "a room".to_string());
    let icon = room
        .as_ref()
        .map(|r| r.icon_url.clone())
        .unwrap_or_default();

    // Addressed to each person rather than broadcast: only the people who
    // answered should hear it, and a room broadcast reaches everyone.
    let event = json!({
        "type": "m.room.event_reminder",
        "room_id": record.room_id,
        "event_id": record.event_id,
        "name": record.name,
        "starts_at": record.starts_at,
        "channel_id": record.channel_id,
        "when": when,
    });
    for user_id in &audience {
        send_to_user(state, user_id, &event).await;
    }

    spawn_event_reminder_push(
        Arc::clone(state),
        EventReminderNotification {
            room_id: record.room_id.clone(),
            room_name,
            event_name: record.name.clone(),
            event_id: record.event_id.clone(),
            icon,
            when,
            audience,
        },
    );
}

/// Nudge each event once, shortly before it starts.
///
/// Nothing else can announce an event starting — it is the absence of an
/// action, the same shape as the presence sweeper — so this runs for the life
/// of the process.
pub(crate) async fn run_event_reminder_scheduler(state: Arc<AppState>) {
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(REMINDER_TICK_SECS));
    interval.tick().await; // the immediate first tick says nothing new

    loop {
        interval.tick().await;
        let now = now_millis();
        let coll = state.db.collection::<EventRecord>("events");

        let Ok(mut cursor) = coll
            .find(doc! {
                "cancelled": false,
                "reminded_at": 0i64,
                "starts_at": {
                    "$lte": now + REMINDER_LEAD_MS,
                    "$gt": now - REMINDER_GRACE_MS,
                },
            })
            .await
        else {
            continue;
        };

        let mut due: Vec<EventRecord> = Vec::new();
        while let Ok(Some(record)) = cursor.try_next().await {
            due.push(record);
        }

        for record in due {
            // Claim it before sending. The filter carries `reminded_at: 0`, so
            // if two processes are running this loop only one update matches
            // and only one reminder goes out.
            let claimed = coll
                .update_one(
                    doc! { "_id": &record.event_id, "reminded_at": 0i64 },
                    doc! { "$set": { "reminded_at": now } },
                )
                .await
                .map(|r| r.modified_count == 1)
                .unwrap_or(false);
            if !claimed {
                continue;
            }
            send_reminder(&state, &record, now).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_event_may_be_entered_while_it_is_already_running() {
        // Someone writes up the thing they are in the middle of. Refusing a
        // start time in the past only teaches them to lie about it.
        let long_ago = now_millis() - 60 * 60 * 1000;
        assert!(validate("Standup", "", "", long_ago, 0).is_ok());
    }

    #[test]
    fn an_open_ended_event_is_allowed_but_a_backwards_one_is_not() {
        let start = now_millis();
        assert!(validate("Hangout", "", "", start, 0).is_ok());
        assert!(validate("Hangout", "", "", start, start + 1).is_ok());
        assert!(validate("Hangout", "", "", start, start).is_err());
        assert!(validate("Hangout", "", "", start, start - 1).is_err());
    }

    #[test]
    fn a_nameless_event_is_refused() {
        assert!(validate("", "", "", now_millis(), 0).is_err());
        assert!(validate("   ", "", "", now_millis(), 0).is_err());
    }

    #[test]
    fn seconds_mistaken_for_millis_are_caught_as_a_date() {
        // 4102444800 is 2100 in seconds; read as millis it is 1970, which is
        // in the past and therefore fine. The other direction is the tell.
        let millis_of_a_seconds_value = 4102444800i64 * 1000 * 1000;
        assert!(validate("Party", "", "", millis_of_a_seconds_value, 0).is_err());
    }

    #[test]
    fn the_reminder_says_how_long_is_left_in_whole_minutes() {
        let now = 1_700_000_000_000i64;
        assert_eq!(when_phrase(now + 10 * 60_000, now), "starts in 10 minutes");
        assert_eq!(when_phrase(now + 60_000, now), "starts in a minute");
        // Part of a minute still rounds up to that minute rather than down to
        // "now" — the event has not started yet and should not claim to have.
        assert_eq!(when_phrase(now + 30_000, now), "starts in a minute");
    }

    #[test]
    fn an_event_at_or_past_its_start_is_starting_now() {
        let now = 1_700_000_000_000i64;
        assert_eq!(when_phrase(now, now), "is starting now");
        // The tick can land a few seconds late; that must not produce a
        // reminder counting backwards.
        assert_eq!(when_phrase(now - 20_000, now), "is starting now");
    }

    #[test]
    fn the_reminder_window_is_the_lead_ahead_and_the_grace_behind() {
        // The window the scheduler queries, stated as the arithmetic it uses,
        // so a change to either constant has to be deliberate.
        let now = 1_700_000_000_000i64;
        let earliest = now - REMINDER_GRACE_MS;
        let latest = now + REMINDER_LEAD_MS;
        let due = |starts_at: i64| starts_at <= latest && starts_at > earliest;

        assert!(due(now + REMINDER_LEAD_MS));
        assert!(!due(now + REMINDER_LEAD_MS + 1));
        assert!(due(now));
        // Long over: a server coming back from downtime must not announce what
        // it slept through.
        assert!(!due(now - REMINDER_GRACE_MS));
        assert!(!due(now - 24 * 60 * 60 * 1000));
    }

    #[test]
    fn a_name_longer_than_the_panel_can_show_is_refused() {
        let long = "x".repeat(MAX_NAME_LEN + 1);
        assert!(validate(&long, "", "", now_millis(), 0).is_err());
        let ok = "x".repeat(MAX_NAME_LEN);
        assert!(validate(&ok, "", "", now_millis(), 0).is_ok());
    }
}
