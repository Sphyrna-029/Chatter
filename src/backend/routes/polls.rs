//! Polls: a question with premade answers, a clock, and a result posted back
//! into the channel it was asked in.
//!
//! A poll **is a message**. The message carries the question, the answers and
//! the closing time; `PollRecord` carries what moves. That split is the whole
//! design: a poll needs no permission model, no listing, no deletion path and
//! no place in search of its own, because it inherits every one of those from
//! the message it arrived as. Deleting the message is deleting the poll.
//!
//! Nothing here decides when a poll ends. `run_poll_scheduler` does, because
//! ending is the absence of an action — the same shape as going idle or an
//! event reminder — and so has to be announced by something that runs on a
//! clock rather than by whoever happens to be looking.

use super::super::{
    dto::{CreatePollRequest, PollVoteRequest},
    helpers::{
        broadcast_to_room, can_manage_messages, channel_permissions, effective_permissions,
        error_response, extract_token, generate_id, get_user_from_token, is_blocked_between,
        now_millis, rate_limited,
    },
    push::{spawn_message_push, MessageNotification},
    ratelimit,
    state::{AppState, ChannelRecord, PollRecord, PollVoteRecord, RoomRecord},
};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::Json,
};
use futures_util::TryStreamExt;
use mongodb::bson::doc;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

/// Long enough for a real question, short enough to read at a glance in the
/// card without the answers falling below the fold.
const MAX_QUESTION_LEN: usize = 300;
const MAX_OPTION_LEN: usize = 100;
/// A poll with one answer is a statement.
const MIN_OPTIONS: usize = 2;
/// Past ten the card stops being scannable and the thing wanted was a thread.
const MAX_OPTIONS: usize = 10;
/// A minute is the shortest poll anyone can actually answer, given the
/// scheduler's tick and the time it takes to read the question.
const MIN_DURATION_MINUTES: i64 = 1;
/// A week. Longer than this and the channel has scrolled past it anyway.
const MAX_DURATION_MINUTES: i64 = 7 * 24 * 60;
/// How often open polls are re-examined for having ended.
///
/// Durations are chosen in minutes, so this only has to be fine enough that
/// "ends in a minute" does not visibly overrun. It is one indexed query
/// against a collection that is empty on most instances.
const POLL_TICK_SECS: u64 = 10;

// ─── Creating ───────────────────────────────────────────────────────────────

/// The caller and the channel their poll will live in, once every check a
/// message send would make has passed.
///
/// A poll is posted as a message, so it must pass exactly what posting a
/// message passes — membership, the room's and the channel's `send_messages`,
/// read-only, and a block in a DM. Anything less would make a poll a way to
/// write into a channel somebody had been kept out of.
async fn authorize_post(
    state: &AppState,
    headers: &HeaderMap,
    room_id: &str,
    requested_channel: Option<&str>,
) -> Result<(String, String, RoomRecord), (StatusCode, Json<Value>)> {
    let token = extract_token(headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let room = state
        .db
        .collection::<RoomRecord>("rooms")
        .find_one(doc! { "_id": room_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Room not found"))?;

    {
        let rm = state.room_members.read().await;
        if !rm
            .get(room_id)
            .map(|m| m.contains(&user_id))
            .unwrap_or(false)
        {
            return Err(error_response(
                StatusCode::FORBIDDEN,
                "Not a member of this room",
            ));
        }
    }

    if !effective_permissions(state, room_id, &user_id)
        .await
        .send_messages
    {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "You do not have permission to post in this room",
        ));
    }

    if room.read_only && !can_manage_messages(state, room_id, &user_id).await {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "This room is read-only",
        ));
    }

    // A DM that already existed when the block happened is still a way to
    // reach someone, so a poll is checked the way a message is.
    if room.is_dm {
        let others: Vec<String> = {
            let rm = state.room_members.read().await;
            rm.get(room_id)
                .map(|m| m.iter().filter(|id| **id != user_id).cloned().collect())
                .unwrap_or_default()
        };
        for other in &others {
            if is_blocked_between(state, &user_id, other).await {
                return Err(error_response(
                    StatusCode::FORBIDDEN,
                    "You cannot post in this conversation",
                ));
            }
        }
    }

    let channel_id = if let Some(cid) = requested_channel.filter(|c| !c.is_empty()) {
        cid.to_string()
    } else if room.is_dm {
        String::new()
    } else {
        super::channels::ensure_default_channels(state, room_id, &user_id).await
    };

    if !channel_id.is_empty() {
        let channel = state
            .db
            .collection::<ChannelRecord>("channels")
            .find_one(doc! { "_id": &channel_id })
            .await
            .ok()
            .flatten()
            .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Channel not found"))?;

        let privileged = can_manage_messages(state, room_id, &user_id).await;
        if channel.read_only && !privileged {
            return Err(error_response(
                StatusCode::FORBIDDEN,
                "This channel is read-only",
            ));
        }
        let perms = channel_permissions(state, room_id, &channel_id, &user_id).await;
        if !perms.view_channel {
            return Err(error_response(
                StatusCode::FORBIDDEN,
                "You do not have access to this channel",
            ));
        }
        if !perms.send_messages {
            return Err(error_response(
                StatusCode::FORBIDDEN,
                "You do not have permission to post in this channel",
            ));
        }
    }

    Ok((user_id, channel_id, room))
}

/// What a poll's question and answers have to satisfy to be worth storing.
///
/// Split out from the handler so the rules are testable without a database:
/// they are the part of a poll that a person can get wrong.
fn validate(question: &str, options: &[String], duration_minutes: i64) -> Result<(), String> {
    let question = question.trim();
    if question.is_empty() {
        return Err("A poll needs a question".to_string());
    }
    if question.chars().count() > MAX_QUESTION_LEN {
        return Err(format!(
            "A question may be at most {MAX_QUESTION_LEN} characters"
        ));
    }

    let filled: Vec<&String> = options.iter().filter(|o| !o.trim().is_empty()).collect();
    if filled.len() < MIN_OPTIONS {
        return Err(format!("A poll needs at least {MIN_OPTIONS} answers"));
    }
    if filled.len() > MAX_OPTIONS {
        return Err(format!("A poll may have at most {MAX_OPTIONS} answers"));
    }
    if filled.iter().any(|o| o.chars().count() > MAX_OPTION_LEN) {
        return Err(format!(
            "An answer may be at most {MAX_OPTION_LEN} characters"
        ));
    }
    // Two answers reading the same make a result nobody can act on: the
    // winning option would not say which of them won.
    let mut seen = HashSet::new();
    for option in &filled {
        if !seen.insert(option.trim().to_lowercase()) {
            return Err("Two answers are the same".to_string());
        }
    }

    if !(MIN_DURATION_MINUTES..=MAX_DURATION_MINUTES).contains(&duration_minutes) {
        return Err(format!(
            "A poll runs for between {MIN_DURATION_MINUTES} minute and {} days",
            MAX_DURATION_MINUTES / (24 * 60)
        ));
    }
    Ok(())
}

pub(crate) async fn create_poll(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
    Json(req): Json<CreatePollRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let (user_id, channel_id, room) =
        authorize_post(&state, &headers, &room_id, req.channel_id.as_deref()).await?;

    if let Err(retry_after) =
        ratelimit::check(&state, &format!("poll:{user_id}"), ratelimit::CREATE_POLL).await
    {
        return Err(rate_limited(
            retry_after,
            "You are creating polls too quickly",
        ));
    }

    validate(&req.question, &req.options, req.duration_minutes)
        .map_err(|e| error_response(StatusCode::BAD_REQUEST, &e))?;

    let question = req.question.trim().to_string();
    let options: Vec<String> = req
        .options
        .iter()
        .map(|o| o.trim().to_string())
        .filter(|o| !o.is_empty())
        .collect();
    let multi_select = req.multi_select.unwrap_or(false);

    let event_id = generate_id("$");
    let now = now_millis();
    let ends_at = now + req.duration_minutes * 60_000;

    // The poll is the message. `body` repeats the question because every
    // surface that summarises a message reads that and nothing else — search,
    // the push notification, the channel-list preview, a shared link's card —
    // and a poll that shows up in all four as an empty line is a poll nobody
    // opens.
    let mut event = json!({
        "type": "m.room.message",
        "room_id": room_id,
        "sender": user_id,
        "content": {
            "msgtype": "m.poll",
            "body": format!("📊 {question}"),
            "poll_id": event_id,
            "question": question,
            "options": options,
            "multi_select": multi_select,
            "ends_at": ends_at,
        },
        "event_id": event_id,
        "origin_server_ts": now,
    });
    if !channel_id.is_empty() {
        event["channel_id"] = json!(channel_id);
    }

    // The record first: a message offering a vote that no record backs would
    // refuse every vote cast on it. The other order strands a poll nothing
    // shows instead, which at least cannot be voted on.
    let record = PollRecord {
        poll_id: event_id.clone(),
        room_id: room_id.clone(),
        channel_id: channel_id.clone(),
        creator: user_id.clone(),
        question: question.clone(),
        options: options.clone(),
        multi_select,
        created_at: now,
        ends_at,
        closed: false,
        closed_at: 0,
        results_event_id: String::new(),
    };
    state
        .db
        .collection::<PollRecord>("polls")
        .insert_one(&record)
        .await
        .map_err(|_| {
            error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to create the poll",
            )
        })?;

    let msg_coll = state.db.collection::<mongodb::bson::Document>("messages");
    if let Ok(doc) = mongodb::bson::to_document(&event) {
        let _ = msg_coll.insert_one(doc).await;
    }

    let mut broadcast = event.clone();
    broadcast["is_dm"] = json!(room.is_dm);
    // Nobody has voted yet, but the card is drawn from this field and an
    // absent one would have every client fetch the state it could have been
    // handed.
    broadcast["poll"] = poll_state_value(&record, &[]);
    broadcast_to_room(&state, &room_id, &broadcast).await;

    let channel_name = channel_name_for(&state, &channel_id).await;
    spawn_message_push(
        Arc::clone(&state),
        MessageNotification {
            room_id: room_id.clone(),
            channel_id: channel_id.clone(),
            event_id: event_id.clone(),
            sender_id: user_id.clone(),
            sender_name: super::messages::display_name_for(&state, &user_id).await,
            room_name: room.name.clone(),
            channel_name,
            body: format!("📊 {question}"),
            icon: room.icon_url.clone(),
            is_dm: room.is_dm,
            audience: None,
            // A poll never role-pings. The question is a question, not a
            // place to reach @everyone from — and unlike a message body,
            // nobody writing one expects it to.
            suppress_role_mentions: true,
        },
    );

    Ok(Json(json!({
        "event_id": event_id,
        "poll": poll_state_value(&record, &[]),
    })))
}

// ─── Voting ─────────────────────────────────────────────────────────────────

pub(crate) async fn vote_poll(
    State(state): State<Arc<AppState>>,
    Path((room_id, poll_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(req): Json<PollVoteRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    if let Err(retry_after) =
        ratelimit::check(&state, &format!("vote:{user_id}"), ratelimit::POLL_VOTE).await
    {
        return Err(rate_limited(retry_after, "You are voting too quickly"));
    }

    let record = require_readable_poll(&state, &room_id, &poll_id, &user_id).await?;

    // Voting is posting, so it takes the same permission. A channel someone
    // may read but not write in is not one they may answer a poll in either.
    if !record.channel_id.is_empty() {
        let perms = channel_permissions(&state, &room_id, &record.channel_id, &user_id).await;
        if !perms.send_messages {
            return Err(error_response(
                StatusCode::FORBIDDEN,
                "You do not have permission to vote in this channel",
            ));
        }
    } else if !effective_permissions(&state, &room_id, &user_id)
        .await
        .send_messages
    {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "You do not have permission to vote in this room",
        ));
    }

    // A poll past its end but not yet swept is closed as far as anyone asking
    // is concerned. Reading the clock rather than the flag means the last
    // seconds cannot be used to answer a poll that has run out.
    if record.closed || now_millis() >= record.ends_at {
        return Err(error_response(StatusCode::CONFLICT, "This poll has ended"));
    }

    let mut chosen: Vec<i64> = req.options.clone();
    chosen.sort_unstable();
    chosen.dedup();
    if chosen
        .iter()
        .any(|i| *i < 0 || *i >= record.options.len() as i64)
    {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "That answer is not on this poll",
        ));
    }
    if !record.multi_select && chosen.len() > 1 {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "This poll allows one answer",
        ));
    }

    // The request states the caller's whole selection, so their old one goes
    // and the new one is written. Changing a vote and withdrawing it are the
    // same operation with a different list.
    let votes = state.db.collection::<PollVoteRecord>("poll_votes");
    let _ = votes
        .delete_many(doc! { "poll_id": &poll_id, "user_id": &user_id })
        .await;
    if !chosen.is_empty() {
        let now = now_millis();
        let fresh: Vec<PollVoteRecord> = chosen
            .iter()
            .map(|index| PollVoteRecord {
                poll_id: poll_id.clone(),
                option_index: *index,
                user_id: user_id.clone(),
                voted_at: now,
            })
            .collect();
        let _ = votes.insert_many(fresh).await;
    }

    let tally = load_votes(&state, &record).await;
    let state_value = poll_state_value(&record, &tally);

    let mut broadcast = json!({
        "type": "m.poll.vote",
        "room_id": room_id,
        "poll_id": poll_id,
        "poll": state_value.clone(),
    });
    if !record.channel_id.is_empty() {
        broadcast["channel_id"] = json!(record.channel_id);
    }
    broadcast_to_room(&state, &room_id, &broadcast).await;

    Ok(Json(json!({ "poll": state_value })))
}

// ─── Reading ────────────────────────────────────────────────────────────────

/// One poll's live state, for a card that arrived without it — a poll opened
/// from the pin list, a search result, or a shared link.
pub(crate) async fn get_poll(
    State(state): State<Arc<AppState>>,
    Path((room_id, poll_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let record = require_readable_poll(&state, &room_id, &poll_id, &user_id).await?;
    let tally = load_votes(&state, &record).await;
    Ok(Json(json!({ "poll": poll_state_value(&record, &tally) })))
}

/// The poll, once the caller is known to be allowed to see the channel it is
/// in. Every refusal answers the same 404: which polls exist in a channel
/// somebody cannot open is itself something they should not learn.
async fn require_readable_poll(
    state: &AppState,
    room_id: &str,
    poll_id: &str,
    user_id: &str,
) -> Result<PollRecord, (StatusCode, Json<Value>)> {
    let not_found = || error_response(StatusCode::NOT_FOUND, "Poll not found");

    {
        let rm = state.room_members.read().await;
        if !rm
            .get(room_id)
            .map(|m| m.contains(&user_id.to_string()))
            .unwrap_or(false)
        {
            return Err(not_found());
        }
    }

    let record = state
        .db
        .collection::<PollRecord>("polls")
        .find_one(doc! { "_id": poll_id, "room_id": room_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(not_found)?;

    if !record.channel_id.is_empty()
        && !channel_permissions(state, room_id, &record.channel_id, user_id)
            .await
            .view_channel
    {
        return Err(not_found());
    }

    Ok(record)
}

// ─── Ending ─────────────────────────────────────────────────────────────────

/// End a poll before its time, which its author or anyone who can manage
/// messages may do. The results are posted exactly as the scheduler would post
/// them, because it is the same function.
pub(crate) async fn close_poll_now(
    State(state): State<Arc<AppState>>,
    Path((room_id, poll_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let record = require_readable_poll(&state, &room_id, &poll_id, &user_id).await?;

    if record.creator != user_id && !can_manage_messages(&state, &room_id, &user_id).await {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "Only the poll's author can end it early",
        ));
    }
    if record.closed {
        return Err(error_response(
            StatusCode::CONFLICT,
            "This poll has already ended",
        ));
    }

    let now = now_millis();
    if !claim(&state, &poll_id, now).await {
        return Err(error_response(
            StatusCode::CONFLICT,
            "This poll has already ended",
        ));
    }
    let closed = close_and_announce(&state, &record, now).await;

    Ok(Json(json!({ "poll": closed })))
}

/// Mark a poll closed, but only if it is not already.
///
/// The filter carries `closed: false`, so of two callers arriving together —
/// the scheduler and an author ending it by hand, or two processes running the
/// scheduler — exactly one update matches and exactly one results message is
/// posted.
async fn claim(state: &AppState, poll_id: &str, now: i64) -> bool {
    state
        .db
        .collection::<PollRecord>("polls")
        .update_one(
            doc! { "_id": poll_id, "closed": false },
            doc! { "$set": { "closed": true, "closed_at": now } },
        )
        .await
        .map(|r| r.modified_count == 1)
        .unwrap_or(false)
}

/// Post the results into the channel the poll was asked in, and tell the room.
///
/// Called only after `claim` has succeeded. Returns the poll's final state.
async fn close_and_announce(state: &Arc<AppState>, record: &PollRecord, now: i64) -> Value {
    let tally = load_votes(state, record).await;
    let counts: Vec<usize> = tally.iter().map(|v| v.len()).collect();
    let total_voters = distinct_voters(&tally);

    let results_event_id = generate_id("$");

    // The results message repeats the question, the answers and the numbers
    // rather than pointing at the poll. It has to read correctly years later,
    // in a search result or an export, with nothing else loaded — and the poll
    // it came from can be deleted.
    let mut event = json!({
        "type": "m.room.message",
        "room_id": record.room_id,
        "sender": record.creator,
        "content": {
            "msgtype": "m.poll_results",
            "body": results_summary(&record.question, &record.options, &counts, total_voters),
            "poll_id": record.poll_id,
            "question": record.question,
            "options": record.options,
            "counts": counts,
            // Who voted for what, carried on the message for the same reason
            // the question and the answers are: the results card names them,
            // and the record that knew is deleted with the poll. A tally is
            // the one part of a poll that cannot be recovered afterwards, so
            // if it is ever going to be shown it has to be written down here.
            "voters": &tally,
            "total_voters": total_voters,
            "multi_select": record.multi_select,
        },
        "event_id": results_event_id,
        "origin_server_ts": now,
    });
    if !record.channel_id.is_empty() {
        event["channel_id"] = json!(record.channel_id);
    }

    let msg_coll = state.db.collection::<mongodb::bson::Document>("messages");
    if let Ok(doc) = mongodb::bson::to_document(&event) {
        let _ = msg_coll.insert_one(doc).await;
    }
    let _ = state
        .db
        .collection::<PollRecord>("polls")
        .update_one(
            doc! { "_id": &record.poll_id },
            doc! { "$set": { "results_event_id": &results_event_id } },
        )
        .await;

    let mut closed = record.clone();
    closed.closed = true;
    closed.closed_at = now;
    let state_value = poll_state_value(&closed, &tally);

    // Two broadcasts, and they are not the same thing: the first turns every
    // open card final, the second puts the results in the channel. A client
    // showing the poll but scrolled away from the bottom needs the first.
    let mut update = json!({
        "type": "m.poll.closed",
        "room_id": record.room_id,
        "poll_id": record.poll_id,
        "poll": state_value.clone(),
    });
    if !record.channel_id.is_empty() {
        update["channel_id"] = json!(record.channel_id);
    }
    broadcast_to_room(state, &record.room_id, &update).await;
    broadcast_to_room(state, &record.room_id, &event).await;

    state_value
}

/// Close every poll whose time has run out.
///
/// Nothing else can announce a poll ending — it is the absence of an action,
/// the same shape as the presence sweeper — so this runs for the life of the
/// process.
pub(crate) async fn run_poll_scheduler(state: Arc<AppState>) {
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(POLL_TICK_SECS));
    interval.tick().await; // the immediate first tick says nothing new

    loop {
        interval.tick().await;
        let now = now_millis();

        let Ok(mut cursor) = state
            .db
            .collection::<PollRecord>("polls")
            .find(doc! { "closed": false, "ends_at": { "$lte": now } })
            .await
        else {
            continue;
        };

        let mut due: Vec<PollRecord> = Vec::new();
        while let Ok(Some(record)) = cursor.try_next().await {
            due.push(record);
        }

        for record in due {
            // A poll whose room or message is gone must not announce itself
            // into a channel that no longer holds it. Claim it either way, so
            // the query does not keep finding it every tick.
            if !claim(&state, &record.poll_id, now).await {
                continue;
            }
            if !message_still_exists(&state, &record.poll_id).await {
                continue;
            }
            close_and_announce(&state, &record, now).await;
        }
    }
}

/// Whether the message that *is* the poll is still in the timeline.
///
/// Deleting a poll deletes the message, and a redaction keeps the row and
/// marks it — so both have to be read, or a poll somebody deleted would post
/// its results into the channel an hour later.
async fn message_still_exists(state: &AppState, poll_id: &str) -> bool {
    state
        .db
        .collection::<mongodb::bson::Document>("messages")
        .find_one(doc! { "event_id": poll_id, "redacted": { "$ne": true } })
        .await
        .ok()
        .flatten()
        .is_some()
}

// ─── Shared ─────────────────────────────────────────────────────────────────

/// Who voted for what, as a list per option index.
///
/// Takes the record rather than an id so the tally has a slot for every
/// option — including the ones nobody picked, which are exactly the slots a
/// map of votes cannot produce.
async fn load_votes(state: &AppState, record: &PollRecord) -> Vec<Vec<String>> {
    let mut by_index: HashMap<i64, Vec<String>> = HashMap::new();
    if let Ok(mut cursor) = state
        .db
        .collection::<PollVoteRecord>("poll_votes")
        .find(doc! { "poll_id": &record.poll_id })
        .await
    {
        while let Ok(Some(vote)) = cursor.try_next().await {
            by_index
                .entry(vote.option_index)
                .or_default()
                .push(vote.user_id);
        }
    }
    votes_by_option(by_index, record.options.len())
}

/// A vote map turned into one list per option, in option order.
fn votes_by_option(mut votes: HashMap<i64, Vec<String>>, options: usize) -> Vec<Vec<String>> {
    (0..options)
        .map(|i| {
            let mut voters = votes.remove(&(i as i64)).unwrap_or_default();
            voters.sort();
            voters
        })
        .collect()
}

/// How many *people* answered. Not the sum of the counts: one person ticking
/// three boxes in a multi-select poll is one voter, and a card reading
/// "3 people voted" when one did would be wrong on the only number the
/// percentages are of.
fn distinct_voters(tally: &[Vec<String>]) -> usize {
    tally.iter().flatten().collect::<HashSet<&String>>().len()
}

/// The wire shape of a poll's live state. One definition, used by the message
/// page, the single-poll fetch, both broadcasts and the create response, so no
/// two of them can describe a poll differently.
fn poll_state_value(record: &PollRecord, tally: &[Vec<String>]) -> Value {
    // An open poll with no votes yet still needs a slot per option: the card
    // draws a bar for each and reads its length from here.
    let voters: Vec<Vec<String>> = if tally.is_empty() {
        record.options.iter().map(|_| Vec::new()).collect()
    } else {
        tally.to_vec()
    };
    json!({
        "poll_id": record.poll_id,
        "voters": voters,
        "total_voters": distinct_voters(&voters),
        "closed": record.closed,
        "ends_at": record.ends_at,
        "multi_select": record.multi_select,
        "creator": record.creator,
    })
}

/// The one-line summary the results message carries as its body.
fn results_summary(
    question: &str,
    options: &[String],
    counts: &[usize],
    total_voters: usize,
) -> String {
    if total_voters == 0 {
        return format!("Poll ended — {question} · nobody voted");
    }
    let top = counts.iter().copied().max().unwrap_or(0);
    let winners: Vec<&str> = options
        .iter()
        .zip(counts.iter())
        .filter(|(_, c)| **c == top)
        .map(|(o, _)| o.as_str())
        .collect();
    let votes = if top == 1 {
        "1 vote".to_string()
    } else {
        format!("{top} votes")
    };

    match winners.as_slice() {
        [only] => format!("Poll ended — {question} · {only} won with {votes}"),
        many => format!(
            "Poll ended — {question} · {} tied with {votes} each",
            many.join(", ")
        ),
    }
}

async fn channel_name_for(state: &AppState, channel_id: &str) -> String {
    if channel_id.is_empty() {
        return String::new();
    }
    state
        .db
        .collection::<ChannelRecord>("channels")
        .find_one(doc! { "_id": channel_id })
        .await
        .ok()
        .flatten()
        .map(|ch| ch.name)
        .unwrap_or_default()
}

/// Forget a poll and every vote cast in it.
///
/// Called when the message that *is* the poll is deleted. Best effort and its
/// result ignored, like the attachment purge beside it: a deletion that
/// succeeded must not report failure because the tidying up behind it did.
pub(crate) async fn purge_poll(state: &AppState, poll_id: &str) {
    let removed = state
        .db
        .collection::<PollRecord>("polls")
        .delete_one(doc! { "_id": poll_id })
        .await
        .map(|r| r.deleted_count > 0)
        .unwrap_or(false);
    // Only when there was a poll: every deleted message would otherwise cost a
    // query against the votes collection to learn it was never a poll.
    if removed {
        let _ = state
            .db
            .collection::<PollVoteRecord>("poll_votes")
            .delete_many(doc! { "poll_id": poll_id })
            .await;
    }
}

/// Live state for every poll among a page of messages, keyed by poll id.
///
/// One query for the page rather than one per card: a channel people run polls
/// in draws twenty of them on open, and twenty round trips to fill in twenty
/// bars is the same mistake the message page already avoids for reactions.
pub(crate) async fn get_polls_for_events(
    state: &AppState,
    poll_ids: &[String],
) -> HashMap<String, Value> {
    let mut result: HashMap<String, Value> = HashMap::new();
    if poll_ids.is_empty() {
        return result;
    }

    let ids: Vec<mongodb::bson::Bson> = poll_ids
        .iter()
        .map(|id| mongodb::bson::Bson::String(id.clone()))
        .collect();

    let mut records: Vec<PollRecord> = Vec::new();
    if let Ok(mut cursor) = state
        .db
        .collection::<PollRecord>("polls")
        .find(doc! { "_id": { "$in": &ids } })
        .await
    {
        while let Ok(Some(record)) = cursor.try_next().await {
            records.push(record);
        }
    }
    if records.is_empty() {
        return result;
    }

    let mut by_poll: HashMap<String, HashMap<i64, Vec<String>>> = HashMap::new();
    if let Ok(mut cursor) = state
        .db
        .collection::<PollVoteRecord>("poll_votes")
        .find(doc! { "poll_id": { "$in": &ids } })
        .await
    {
        while let Ok(Some(vote)) = cursor.try_next().await {
            by_poll
                .entry(vote.poll_id)
                .or_default()
                .entry(vote.option_index)
                .or_default()
                .push(vote.user_id);
        }
    }

    for record in records {
        let votes = by_poll.remove(&record.poll_id).unwrap_or_default();
        let tally = votes_by_option(votes, record.options.len());
        result.insert(record.poll_id.clone(), poll_state_value(&record, &tally));
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_poll_needs_a_question_and_two_answers() {
        assert!(validate("Lunch?", &options(&["Tacos", "Ramen"]), 60).is_ok());
        assert!(validate("   ", &options(&["Tacos", "Ramen"]), 60).is_err());
        assert!(validate("Lunch?", &options(&["Tacos"]), 60).is_err());
    }

    #[test]
    fn blank_answers_are_dropped_before_they_are_counted() {
        // The composer offers empty rows, so a two-answer poll arrives with
        // several of them. What matters is how many are filled in.
        assert!(validate("Lunch?", &options(&["Tacos", "Ramen", "", "  "]), 60).is_ok());
        assert!(validate("Lunch?", &options(&["Tacos", "", ""]), 60).is_err());
    }

    #[test]
    fn two_answers_that_read_the_same_are_refused() {
        // Whichever won, the result would not say which of them it was.
        assert!(validate("Lunch?", &options(&["Tacos", " tacos "]), 60).is_err());
    }

    #[test]
    fn a_duration_outside_the_range_is_refused() {
        assert!(validate("Lunch?", &options(&["A", "B"]), MIN_DURATION_MINUTES).is_ok());
        assert!(validate("Lunch?", &options(&["A", "B"]), MAX_DURATION_MINUTES).is_ok());
        assert!(validate("Lunch?", &options(&["A", "B"]), 0).is_err());
        assert!(validate("Lunch?", &options(&["A", "B"]), -60).is_err());
        assert!(validate("Lunch?", &options(&["A", "B"]), MAX_DURATION_MINUTES + 1).is_err());
    }

    #[test]
    fn an_option_nobody_picked_still_has_a_slot() {
        // The card draws a bar per option and reads its length from the tally,
        // so a trailing option with no votes has to survive the conversion.
        let mut votes: HashMap<i64, Vec<String>> = HashMap::new();
        votes.insert(0, vec!["@a:h".into()]);
        let tally = votes_by_option(votes, 3);
        assert_eq!(tally.len(), 3);
        assert_eq!(tally[1].len(), 0);
        assert_eq!(tally[2].len(), 0);
    }

    #[test]
    fn a_multi_select_voter_is_counted_once() {
        // The percentages are of the number of people, so one person ticking
        // three boxes must not read as three voters.
        let tally = vec![
            vec!["@a:h".to_string()],
            vec!["@a:h".to_string(), "@b:h".to_string()],
            vec!["@a:h".to_string()],
        ];
        assert_eq!(distinct_voters(&tally), 2);
    }

    #[test]
    fn the_summary_names_the_winner_or_says_it_was_a_tie() {
        let opts = options(&["Tacos", "Ramen"]);
        let one = results_summary("Lunch?", &opts, &[3, 1], 4);
        assert!(one.contains("Tacos won with 3 votes"), "{one}");

        let tie = results_summary("Lunch?", &opts, &[2, 2], 4);
        assert!(tie.contains("Tacos, Ramen tied with 2 votes each"), "{tie}");

        let single = results_summary("Lunch?", &opts, &[1, 0], 1);
        assert!(single.contains("won with 1 vote"), "{single}");

        let none = results_summary("Lunch?", &opts, &[0, 0], 0);
        assert!(none.contains("nobody voted"), "{none}");
    }
}
