//! Shared message links, and the per-viewer preview behind them.
//!
//! A link to a message is just its event id, because one identifies a message
//! across the whole instance — `generate_id` gives it 16 random bytes. What the
//! link deliberately does *not* carry is the room, the channel, or anything
//! about the message itself: all of that is resolved here, per viewer, so that
//! the same link shows a preview to someone who can read the message and
//! nothing at all to someone who cannot.
//!
//! That is the whole reason this is an endpoint rather than metadata baked into
//! the message when it is posted. Permission to read a channel is a property of
//! the person looking, not of the link — an unfurl stored on the sharing
//! message would be a copy of private content sitting in a channel whose
//! members were never allowed to see it.

use super::super::{
    helpers::{error_response, extract_token, get_allowed_channel_ids, get_user_from_token},
    ratelimit,
    state::{AppState, ChannelRecord, RoomRecord, UserRecord},
};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::Json,
};
use mongodb::bson::doc;
use serde_json::{json, Value};
use std::sync::Arc;

/// How much of the message body a preview card carries. Enough to recognise
/// the message, far short of reproducing it somewhere it does not belong.
const PREVIEW_BODY_CHARS: usize = 200;

/// Every refusal answers with this, whatever the reason.
///
/// "No such message", "you are not in that room" and "you cannot see that
/// channel" are one answer on purpose. Distinguishing them would turn the
/// endpoint into an oracle: anyone holding a link could learn that it names a
/// real message in a channel they were never admitted to, and the point of the
/// feature is that a link tells its recipient nothing they were not already
/// entitled to know.
fn unavailable() -> (StatusCode, Json<Value>) {
    error_response(StatusCode::NOT_FOUND, "That message is not available")
}

/// The body as a preview card should show it: attachment URLs dropped, runs of
/// whitespace collapsed, and cut to length on a character boundary.
///
/// Attachment URLs go because a card is not where they render — the count of
/// them is reported separately — and because a message that is only a photo
/// would otherwise preview as forty characters of percent-encoded filename.
fn preview_text(body: &str) -> String {
    let without_uploads = body
        .split_whitespace()
        .filter(|token| !token.contains("/external/"))
        .collect::<Vec<_>>()
        .join(" ");

    if without_uploads.chars().count() <= PREVIEW_BODY_CHARS {
        return without_uploads;
    }
    // `char_indices` rather than a byte slice: a cut mid-codepoint panics, and
    // a message body is whatever anyone typed.
    let cut = without_uploads
        .char_indices()
        .nth(PREVIEW_BODY_CHARS)
        .map(|(i, _)| i)
        .unwrap_or(without_uploads.len());
    format!("{}…", without_uploads[..cut].trim_end())
}

/// GET /api/messages/{event_id}/preview
///
/// Resolves a shared link to everything needed both to draw its card and to
/// jump to the message: the room and channel it lives in, and its timestamp,
/// which is what `loadMessagesAround` centres a timeline on.
pub(crate) async fn get_message_preview(
    State(state): State<Arc<AppState>>,
    Path(event_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    // A channel full of links draws a card apiece, so the burst has to cover a
    // whole page of them at once; see `MESSAGE_PREVIEW` for why the refill can
    // still be slow enough to meter a script walking event ids.
    if let Err(retry_after) = ratelimit::check(
        &state,
        &format!("msgpreview:{user_id}"),
        ratelimit::MESSAGE_PREVIEW,
    )
    .await
    {
        return Err(error_response(
            StatusCode::TOO_MANY_REQUESTS,
            &format!("Slow down — try again in {:.0}s", retry_after.ceil()),
        ));
    }

    let msg_coll = state.db.collection::<mongodb::bson::Document>("messages");
    let doc = msg_coll
        .find_one(doc! { "event_id": &event_id })
        .await
        .map_err(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "DB query failed"))?
        .ok_or_else(unavailable)?;

    if doc.get_bool("redacted").unwrap_or(false) {
        return Err(unavailable());
    }
    // A thread reply is reachable only by opening its thread, and `pendingJump`
    // cannot carry one. Refusing here rather than in the client is what keeps a
    // hand-written link from producing a card that goes nowhere when clicked.
    if doc.get_str("thread_id").is_ok() {
        return Err(unavailable());
    }

    let room_id = doc.get_str("room_id").map_err(|_| unavailable())?;
    let channel_id = doc.get_str("channel_id").unwrap_or("");

    // Membership first, then the channel within it. Both answer `unavailable`,
    // so the order is about cost, not about what is disclosed.
    {
        let rm = state.room_members.read().await;
        if !rm
            .get(room_id)
            .map(|members| members.contains(&user_id))
            .unwrap_or(false)
        {
            return Err(unavailable());
        }
    }
    if !channel_id.is_empty() {
        if let Some(allowed) = get_allowed_channel_ids(&state, room_id, &user_id).await {
            if !allowed.iter().any(|c| c == channel_id) {
                return Err(unavailable());
            }
        }
    }

    let content = doc.get_document("content").map_err(|_| unavailable())?;
    let body = content.get_str("body").unwrap_or("");
    let spoiler = content.get_bool("spoiler").unwrap_or(false);
    let sender = doc.get_str("sender").unwrap_or("");

    // A spoiler's whole purpose is not being shown until it is asked for, and a
    // card drawn somewhere else is the one place nobody can ask. The flag
    // travels instead of the text.
    let (preview, attachment_count) = if spoiler {
        (String::new(), 0)
    } else {
        (
            preview_text(body),
            super::media::attachment_folders(body).len(),
        )
    };

    // A bot or webhook posts under a name of its own, which is what the message
    // is drawn with everywhere else — so it is what the card has to show too,
    // rather than the account that owns the integration.
    let (display_name, avatar_url) = if let Ok(bot_name) = content.get_str("bot_name") {
        (
            bot_name.to_string(),
            content.get_str("bot_avatar_url").unwrap_or("").to_string(),
        )
    } else if let Ok(webhook_name) = content.get_str("webhook_name") {
        (
            webhook_name.to_string(),
            content
                .get_str("webhook_avatar_url")
                .unwrap_or("")
                .to_string(),
        )
    } else {
        let users_coll = state.db.collection::<UserRecord>("users");
        match users_coll.find_one(doc! { "_id": sender }).await {
            Ok(Some(user)) => (user.display_name, user.avatar_url),
            _ => (String::new(), String::new()),
        }
    };

    let room_name = state
        .db
        .collection::<RoomRecord>("rooms")
        .find_one(doc! { "_id": room_id })
        .await
        .ok()
        .flatten()
        .map(|r| r.name)
        .unwrap_or_default();

    let channel_name = if channel_id.is_empty() {
        None
    } else {
        state
            .db
            .collection::<ChannelRecord>("channels")
            .find_one(doc! { "_id": channel_id })
            .await
            .ok()
            .flatten()
            .map(|c| c.name)
    };

    Ok(Json(json!({
        "event_id": event_id,
        "room_id": room_id,
        "room_name": room_name,
        // Absent rather than empty for a DM, and for a message from before the
        // room had channels — the client's `MessageTarget` draws the same
        // distinction, and a jump keys off it.
        "channel_id": (!channel_id.is_empty()).then_some(channel_id),
        "channel_name": channel_name,
        "sender": sender,
        "sender_display_name": display_name,
        "sender_avatar_url": avatar_url,
        "body": preview,
        "spoiler": spoiler,
        "attachment_count": attachment_count,
        "origin_server_ts": doc.get_i64("origin_server_ts").unwrap_or(0),
        "edited": doc.get_bool("edited").unwrap_or(false),
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_short_body_is_left_alone() {
        assert_eq!(preview_text("hello there"), "hello there");
    }

    #[test]
    fn newlines_and_runs_of_space_collapse() {
        // A card is one or two lines in a fixed box; the message's own shape
        // would otherwise decide how tall someone else's chat is.
        assert_eq!(
            preview_text("first line\n\n   second    line\t\tthird"),
            "first line second line third"
        );
    }

    #[test]
    fn attachment_urls_are_dropped_from_the_text() {
        // They are reported as a count and drawn as a paperclip; left in, a
        // message that is only a photo previews as a percent-encoded filename.
        let body =
            "look at this https://chat.example/external/0123456789abcdef0123456789abcdef/cat.png";
        assert_eq!(preview_text(body), "look at this");
        assert_eq!(preview_text("/external/abc/only.png"), "");
    }

    #[test]
    fn a_long_body_is_cut_and_marked() {
        let body = "a".repeat(PREVIEW_BODY_CHARS + 50);
        let preview = preview_text(&body);
        assert!(preview.ends_with('…'), "got {preview}");
        assert_eq!(preview.chars().count(), PREVIEW_BODY_CHARS + 1);
    }

    #[test]
    fn a_cut_lands_between_characters_not_inside_one() {
        // The cut is by character, not by byte: slicing a multi-byte codepoint
        // in half panics, and a body is whatever somebody typed.
        let body = "🙂".repeat(PREVIEW_BODY_CHARS + 20);
        let preview = preview_text(&body);
        assert_eq!(preview.chars().count(), PREVIEW_BODY_CHARS + 1);
        assert!(preview.starts_with('🙂'));
    }
}
