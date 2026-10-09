//! Shared forum post and reply links, and the per-viewer preview behind them.
//!
//! A link to a forum post is just its post id — `generate_id` gives it 16
//! random bytes, so one identifies a post across the whole instance — and a
//! reply adds the comment id it answers. What the link deliberately does *not*
//! carry is the room, the forum channel, the title or the body: all of that is
//! resolved here, per viewer, so the same link shows a card to someone who may
//! read the post and nothing at all to someone who may not.
//!
//! That is the whole reason this is an endpoint rather than metadata baked into
//! the post when it is written. Permission to read a forum channel is a property
//! of the person looking, not of the link — an unfurl stored on the sharing
//! post would be a copy of private content sitting somewhere its members were
//! never allowed to see. See `routes/message_links.rs`, which this mirrors.

use super::super::{
    helpers::{error_response, extract_token, get_allowed_channel_ids, get_user_from_token},
    ratelimit,
    state::{
        AppState, ChannelRecord, ForumCommentRecord, ForumPostRecord, RoomRecord, UserRecord,
    },
};
use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::Json,
};
use mongodb::bson::doc;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

/// How much of a post or reply body a preview card carries. Enough to recognise
/// it, far short of reproducing it somewhere it does not belong.
const PREVIEW_BODY_CHARS: usize = 200;

/// Every refusal answers with this, whatever the reason.
///
/// "No such post", "you are not in that room", "you cannot see that forum
/// channel", "that reply is not under that post" and "it was deleted" are one
/// answer on purpose. Distinguishing them would turn the endpoint into an
/// oracle: anyone holding a link could learn it names a real post in a channel
/// they were never admitted to.
fn unavailable() -> (StatusCode, Json<Value>) {
    error_response(StatusCode::NOT_FOUND, "That post is not available")
}

/// The body as a preview card should show it: attachment URLs dropped, runs of
/// whitespace collapsed, and cut to length on a character boundary.
///
/// Attachment URLs go because a card is not where they render, and a post whose
/// whole content is a picture would otherwise preview as a percent-encoded
/// filename.
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
    // a body is whatever anyone typed.
    let cut = without_uploads
        .char_indices()
        .nth(PREVIEW_BODY_CHARS)
        .map(|(i, _)| i)
        .unwrap_or(without_uploads.len());
    format!("{}…", without_uploads[..cut].trim_end())
}

/// The display name and avatar behind an author id. A post or reply is drawn
/// with the author's own name everywhere else, so the card has to show that too
/// rather than the account that happens to be looking.
async fn author_name(state: &Arc<AppState>, author: &str) -> (String, String) {
    let users_coll = state.db.collection::<UserRecord>("users");
    match users_coll.find_one(doc! { "_id": author }).await {
        Ok(Some(user)) => (user.display_name, user.avatar_url),
        _ => (String::new(), String::new()),
    }
}

/// GET /api/forum/posts/{post_id}/preview
///
/// Resolves a shared link to everything needed both to draw its card and to
/// jump to the post: the room and forum channel it lives in, its title, and the
/// author. With `?comment_id=` it resolves a reply instead — the reply's own
/// author and body, under the post it belongs to.
pub(crate) async fn get_forum_preview(
    State(state): State<Arc<AppState>>,
    Path(post_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<ForumPreviewQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    // A forum full of shared links draws a card apiece, so the burst has to
    // cover a whole page of them at once; the refill is still slow enough to
    // meter a script walking post ids.
    if let Err(retry_after) = ratelimit::check(
        &state,
        &format!("forumpreview:{user_id}"),
        ratelimit::MESSAGE_PREVIEW,
    )
    .await
    {
        return Err(error_response(
            StatusCode::TOO_MANY_REQUESTS,
            &format!("Slow down — try again in {:.0}s", retry_after.ceil()),
        ));
    }

    let posts_coll = state.db.collection::<ForumPostRecord>("forum_posts");
    let post = posts_coll
        .find_one(doc! { "_id": &post_id })
        .await
        .map_err(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "DB query failed"))?
        .ok_or_else(unavailable)?;

    if post.deleted {
        return Err(unavailable());
    }

    let room_id = post.room_id;
    let channel_id = post.channel_id;

    // Membership first, then the channel within it. Both answer `unavailable`,
    // so the order is about cost, not about what is disclosed.
    {
        let rm = state.room_members.read().await;
        if !rm
            .get(&room_id)
            .map(|members| members.contains(&user_id))
            .unwrap_or(false)
        {
            return Err(unavailable());
        }
    }
    if !channel_id.is_empty() {
        if let Some(allowed) = get_allowed_channel_ids(&state, &room_id, &user_id).await {
            if !allowed.iter().any(|c| *c == channel_id) {
                return Err(unavailable());
            }
        }
    }

    // A reply is resolved only when it really answers this post. A hand-written
    // link that pairs a comment id from another post must not draw that comment
    // under a post it never belonged to.
    let comment_id = query.comment_id.unwrap_or_default();
    let reply = if comment_id.is_empty() {
        None
    } else {
        let comments_coll = state.db.collection::<ForumCommentRecord>("forum_comments");
        let found = comments_coll
            .find_one(doc! { "_id": &comment_id })
            .await
            .ok()
            .flatten();
        match found {
            Some(c) if !c.deleted && c.post_id == post_id => Some(c),
            _ => return Err(unavailable()),
        }
    };

    let room_name = state
        .db
        .collection::<RoomRecord>("rooms")
        .find_one(doc! { "_id": &room_id })
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
            .find_one(doc! { "_id": &channel_id })
            .await
            .ok()
            .flatten()
            .map(|c| c.name)
    };

    // For a post the card speaks about the post; for a reply it speaks about the
    // reply, under the post's title. One shape, so the client draws both the
    // same way.
    let is_reply = reply.is_some();
    let (author, body, created_at, edited) = match reply {
        None => (post.author, post.body, post.created_at, post.edited),
        Some(c) => (c.author, c.body, c.created_at, c.edited),
    };
    let (display_name, avatar_url) = author_name(&state, &author).await;

    Ok(Json(json!({
        // "reply" tells the client this card is a reply under a post, so it can
        // say so rather than pass the reply off as a post.
        "kind": if is_reply { "reply" } else { "post" },
        "post_id": post_id,
        "comment_id": (!comment_id.is_empty()).then_some(comment_id),
        "room_id": room_id,
        "room_name": room_name,
        "channel_id": (!channel_id.is_empty()).then_some(channel_id),
        "channel_name": channel_name,
        // Always the post's title: it is the name a post link unfurls to, and
        // the forum a reply link sits under.
        "title": post.title,
        "author": author,
        "author_display_name": display_name,
        "author_avatar_url": avatar_url,
        "body": preview_text(&body),
        "created_at": created_at,
        "edited": edited,
        "comment_count": post.comment_count,
    })))
}

/// The optional reply a preview is asked for. Absent means the post itself.
#[derive(Deserialize)]
pub(crate) struct ForumPreviewQuery {
    pub(crate) comment_id: Option<String>,
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
        assert_eq!(
            preview_text("first line\n\n   second    line\t\tthird"),
            "first line second line third",
        );
    }

    #[test]
    fn attachment_urls_are_dropped_from_the_text() {
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
        let body = "🙂".repeat(PREVIEW_BODY_CHARS + 20);
        let preview = preview_text(&body);
        assert_eq!(preview.chars().count(), PREVIEW_BODY_CHARS + 1);
        assert!(preview.starts_with('🙂'));
    }
}