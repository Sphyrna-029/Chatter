use super::super::{
    dto::{
        CreateForumCommentRequest, CreateForumPostRequest, EditForumCommentRequest,
        EditForumPostRequest, ForumPostsQuery, ForumSearchQuery,
    },
    helpers::{
        broadcast_to_room, error_response, extract_token, generate_id, get_user_from_token,
        is_moderator_or_owner, now_millis,
    },
    state::{
        AppState, ChannelRecord, ForumCommentRecord, ForumPostRecord, ReactionRecord, RoomRecord,
    },
};
use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::Json,
};
use futures_util::TryStreamExt;
use mongodb::bson::doc;
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Arc};

/// Validate room is forum type and user is a member. Returns (user_id, room).
async fn validate_forum_member(
    state: &AppState,
    headers: &HeaderMap,
    room_id: &str,
) -> Result<String, (StatusCode, Json<Value>)> {
    let token = extract_token(headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let rooms_coll = state.db.collection::<RoomRecord>("rooms");
    let room = rooms_coll
        .find_one(doc! { "_id": room_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Room not found"))?;

    // Accept rooms with room_type "forum" OR rooms that have a forum-type channel
    if room.room_type != "forum" {
        let channels_coll = state.db.collection::<ChannelRecord>("channels");
        let has_forum_channel = channels_coll
            .find_one(doc! { "room_id": room_id, "channel_type": "forum" })
            .await
            .ok()
            .flatten()
            .is_some();
        if !has_forum_channel {
            return Err(error_response(
                StatusCode::BAD_REQUEST,
                "Room is not a forum",
            ));
        }
    }

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

    Ok(user_id)
}

/// How many images and videos one post or comment may carry between them.
/// Matches the composer's attachment limit, so the two surfaces say the same
/// thing.
const MAX_FORUM_MEDIA: usize = 10;

/// Every image on a post or comment.
///
/// `image_url` was the whole of it before a post could carry more than one, and
/// rows written then have only that field. Reading through here means those
/// posts keep their image without a migration having to touch them.
fn images_of(single: &str, many: &[String]) -> Vec<String> {
    if !many.is_empty() {
        many.to_vec()
    } else if !single.is_empty() {
        vec![single.to_string()]
    } else {
        Vec::new()
    }
}

/// The urls a create request is asking for, with the blanks dropped.
fn requested_media(many: &Option<Vec<String>>) -> Vec<String> {
    let mut urls = many.clone().unwrap_or_default();
    urls.retain(|url| !url.trim().is_empty());
    urls
}

/// The images a create request is asking for, from either shape of client.
fn requested_images(single: &Option<String>, many: &Option<Vec<String>>) -> Vec<String> {
    let mut urls = many.clone().unwrap_or_default();
    if urls.is_empty() {
        if let Some(url) = single {
            urls.push(url.clone());
        }
    }
    urls.retain(|url| !url.trim().is_empty());
    urls
}

fn post_to_json(post: &ForumPostRecord, reactions: &HashMap<String, Vec<String>>) -> Value {
    let images = images_of(&post.image_url, &post.image_urls);
    let videos = post.video_urls.clone();
    json!({
        "post_id": post.post_id,
        "room_id": post.room_id,
        "author": post.author,
        "title": post.title,
        "body": post.body,
        // Both shapes: a client that only knows the single field still gets the
        // lead image rather than an empty post.
        "image_url": images.first().cloned().unwrap_or_default(),
        "image_urls": images,
        "video_urls": videos,
        "created_at": post.created_at,
        "comment_count": post.comment_count,
        "last_activity": if post.last_activity > 0 { post.last_activity } else { post.created_at },
        "reactions": reactions,
        "edited": post.edited,
        "edited_at": post.edited_at,
    })
}

fn comment_to_json(comment: &ForumCommentRecord) -> Value {
    // A deleted comment is still sent when replies hang off it, so the thread
    // below does not lose its shape — but nothing it said goes with it.
    if comment.deleted {
        return json!({
            "comment_id": comment.comment_id,
            "post_id": comment.post_id,
            "room_id": comment.room_id,
            "parent_id": comment.parent_id,
            "author": "",
            "body": "",
            "image_url": "",
            "image_urls": [],
            "video_urls": [],
            "created_at": comment.created_at,
            "deleted": true,
        });
    }
    let images = images_of(&comment.image_url, &comment.image_urls);
    json!({
        "comment_id": comment.comment_id,
        "post_id": comment.post_id,
        "room_id": comment.room_id,
        "parent_id": comment.parent_id,
        "author": comment.author,
        "body": comment.body,
        "image_url": images.first().cloned().unwrap_or_default(),
        "image_urls": images,
        "video_urls": comment.video_urls.clone(),
        "created_at": comment.created_at,
        "deleted": false,
        "edited": comment.edited,
        "edited_at": comment.edited_at,
    })
}

/// Which of a post's comments are worth sending.
///
/// A deleted comment normally goes, but one with a living reply under it has to
/// stay as a tombstone or everything below it is orphaned out of the thread.
/// Comments arrive oldest first and a parent always predates its children, so
/// walking backwards means a kept child has always marked its parent by the
/// time that parent is reached.
fn comments_worth_sending(comments: &[ForumCommentRecord]) -> Vec<bool> {
    let index_of: HashMap<&str, usize> = comments
        .iter()
        .enumerate()
        .map(|(i, c)| (c.comment_id.as_str(), i))
        .collect();
    let mut keep = vec![false; comments.len()];
    for i in (0..comments.len()).rev() {
        if !comments[i].deleted {
            keep[i] = true;
        }
        if keep[i] {
            if let Some(&parent) = index_of.get(comments[i].parent_id.as_str()) {
                keep[parent] = true;
            }
        }
    }
    keep
}

async fn get_reactions_for_event(state: &AppState, event_id: &str) -> HashMap<String, Vec<String>> {
    let react_coll = state.db.collection::<ReactionRecord>("reactions");
    let mut reactions: HashMap<String, Vec<String>> = HashMap::new();

    if let Ok(mut cursor) = react_coll.find(doc! { "event_id": event_id }).await {
        while let Ok(Some(record)) = cursor.try_next().await {
            reactions
                .entry(record.emoji)
                .or_default()
                .push(record.user_id);
        }
    }

    reactions
}

// ─── 1. Create Post ─────────────────────────────────────────────────────────

pub(crate) async fn create_post(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
    Json(req): Json<CreateForumPostRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let user_id = validate_forum_member(&state, &headers, &room_id).await?;

    // Validate
    let title = req.title.trim().to_string();
    if title.is_empty() || title.len() > 200 {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "Title must be 1-200 characters",
        ));
    }
    if req.body.len() > 4000 {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "Body must be at most 4000 characters",
        ));
    }

    let images = requested_images(&req.image_url, &req.image_urls);
    let videos = requested_media(&req.video_urls);
    if images.len() + videos.len() > MAX_FORUM_MEDIA {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            &format!("A post may have at most {MAX_FORUM_MEDIA} images and videos"),
        ));
    }

    let post_id = generate_id("post_");
    let now = now_millis();
    let post = ForumPostRecord {
        post_id: post_id.clone(),
        room_id: room_id.clone(),
        author: user_id.clone(),
        title: title.clone(),
        body: req.body.clone(),
        image_url: images.first().cloned().unwrap_or_default(),
        image_urls: images,
        video_urls: videos,
        created_at: now,
        comment_count: 0,
        last_activity: now,
        deleted: false,
        edited: false,
        edited_at: 0,
    };

    let coll = state.db.collection::<ForumPostRecord>("forum_posts");
    let _ = coll.insert_one(&post).await;

    let post_json = post_to_json(&post, &HashMap::new());
    let broadcast_msg = json!({
        "type": "forum.post.created",
        "room_id": room_id,
        "post": post_json,
    });
    broadcast_to_room(&state, &room_id, &broadcast_msg).await;

    Ok(Json(json!({ "post_id": post_id })))
}

// ─── 2. List Posts ──────────────────────────────────────────────────────────

pub(crate) async fn list_posts(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<ForumPostsQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let _user_id = validate_forum_member(&state, &headers, &room_id).await?;

    let limit = query.limit.unwrap_or(20).min(50);
    let coll = state.db.collection::<ForumPostRecord>("forum_posts");

    let sort_mode = query.sort.as_deref().unwrap_or("activity");
    let (sort_field, sort_dir) = match sort_mode {
        "oldest" => ("created_at", 1),
        "newest" => ("created_at", -1),
        "popular" => ("comment_count", -1),
        _ => ("last_activity", -1), // "activity" default
    };

    let cursor_field = sort_field;
    let filter = if let Some(before) = query.before {
        let op = if sort_dir == -1 { "$lt" } else { "$gt" };
        doc! { "room_id": &room_id, "deleted": false, cursor_field: { op: before } }
    } else {
        doc! { "room_id": &room_id, "deleted": false }
    };

    let mut posts: Vec<Value> = Vec::new();
    if let Ok(mut cursor) = coll
        .find(filter)
        .sort(doc! { sort_field: sort_dir })
        .limit(limit + 1)
        .await
    {
        while let Ok(Some(post)) = cursor.try_next().await {
            if posts.len() < limit as usize {
                let reactions = get_reactions_for_event(&state, &post.post_id).await;
                posts.push(post_to_json(&post, &reactions));
            }
        }
    }

    let has_more = posts.len() > limit as usize;
    if has_more {
        posts.truncate(limit as usize);
    }

    Ok(Json(json!({ "posts": posts, "has_more": has_more })))
}

// ─── 3. Get Post ────────────────────────────────────────────────────────────

pub(crate) async fn get_post(
    State(state): State<Arc<AppState>>,
    Path((room_id, post_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let _user_id = validate_forum_member(&state, &headers, &room_id).await?;

    let coll = state.db.collection::<ForumPostRecord>("forum_posts");
    let post = coll
        .find_one(doc! { "_id": &post_id, "room_id": &room_id, "deleted": false })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Post not found"))?;

    let reactions = get_reactions_for_event(&state, &post_id).await;

    // Deleted comments are fetched too, then filtered below: one with a living
    // reply under it has to stay, or the replies lose their place in the thread.
    let comments_coll = state.db.collection::<ForumCommentRecord>("forum_comments");
    let mut records: Vec<ForumCommentRecord> = Vec::new();
    if let Ok(mut cursor) = comments_coll
        .find(doc! { "post_id": &post_id })
        .sort(doc! { "created_at": 1 })
        .await
    {
        while let Ok(Some(comment)) = cursor.try_next().await {
            records.push(comment);
        }
    }
    let keep = comments_worth_sending(&records);
    let comments: Vec<Value> = records
        .iter()
        .zip(keep)
        .filter(|(_, keep)| *keep)
        .map(|(comment, _)| comment_to_json(comment))
        .collect();

    Ok(Json(json!({
        "post": post_to_json(&post, &reactions),
        "comments": comments,
    })))
}

// ─── 4. Delete Post ─────────────────────────────────────────────────────────

pub(crate) async fn delete_post(
    State(state): State<Arc<AppState>>,
    Path((room_id, post_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let user_id = validate_forum_member(&state, &headers, &room_id).await?;

    let coll = state.db.collection::<ForumPostRecord>("forum_posts");
    let post = coll
        .find_one(doc! { "_id": &post_id, "room_id": &room_id, "deleted": false })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Post not found"))?;

    // Check permission: author or moderator/owner
    if post.author != user_id && !is_moderator_or_owner(&state, &room_id, &user_id).await {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "Only the author or a moderator can delete this post",
        ));
    }

    let _ = coll
        .update_one(
            doc! { "_id": &post_id },
            doc! { "$set": { "deleted": true } },
        )
        .await;

    let broadcast_msg = json!({
        "type": "forum.post.deleted",
        "room_id": room_id,
        "post_id": post_id,
    });
    broadcast_to_room(&state, &room_id, &broadcast_msg).await;

    Ok(Json(json!({ "deleted": true })))
}

// ─── 5. Create Comment ──────────────────────────────────────────────────────

pub(crate) async fn create_comment(
    State(state): State<Arc<AppState>>,
    Path((room_id, post_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(req): Json<CreateForumCommentRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let user_id = validate_forum_member(&state, &headers, &room_id).await?;

    // Check post exists
    let posts_coll = state.db.collection::<ForumPostRecord>("forum_posts");
    let _post = posts_coll
        .find_one(doc! { "_id": &post_id, "room_id": &room_id, "deleted": false })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Post not found"))?;

    if req.body.trim().is_empty() || req.body.len() > 2000 {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "Comment body must be 1-2000 characters",
        ));
    }

    let images = requested_images(&req.image_url, &req.image_urls);
    let videos = requested_media(&req.video_urls);
    if images.len() + videos.len() > MAX_FORUM_MEDIA {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            &format!("A comment may have at most {MAX_FORUM_MEDIA} images and videos"),
        ));
    }

    // Checked rather than trusted: a reply pointing at something that is not a
    // live comment on this post would hang off nothing, and the thread would
    // simply lose it. Requiring the parent to exist first also makes a cycle
    // impossible to build.
    let parent_id = req.parent_id.clone().unwrap_or_default();
    if !parent_id.is_empty() {
        let comments_coll = state.db.collection::<ForumCommentRecord>("forum_comments");
        let parent_exists = comments_coll
            .find_one(doc! { "_id": &parent_id, "post_id": &post_id, "deleted": false })
            .await
            .ok()
            .flatten()
            .is_some();
        if !parent_exists {
            return Err(error_response(
                StatusCode::NOT_FOUND,
                "The comment being replied to is no longer there",
            ));
        }
    }

    let comment_id = generate_id("cmt_");
    let now = now_millis();
    let comment = ForumCommentRecord {
        comment_id: comment_id.clone(),
        post_id: post_id.clone(),
        room_id: room_id.clone(),
        author: user_id.clone(),
        body: req.body.clone(),
        image_url: images.first().cloned().unwrap_or_default(),
        image_urls: images,
        video_urls: videos,
        parent_id,
        created_at: now,
        deleted: false,
        edited: false,
        edited_at: 0,
    };

    let coll = state.db.collection::<ForumCommentRecord>("forum_comments");
    let _ = coll.insert_one(&comment).await;

    // Increment comment_count and bump last_activity
    let _ = posts_coll
        .update_one(
            doc! { "_id": &post_id },
            doc! { "$inc": { "comment_count": 1 }, "$set": { "last_activity": now } },
        )
        .await;

    let comment_json = comment_to_json(&comment);
    let broadcast_msg = json!({
        "type": "forum.comment.created",
        "room_id": room_id,
        "post_id": post_id,
        "comment": comment_json,
    });
    broadcast_to_room(&state, &room_id, &broadcast_msg).await;

    Ok(Json(json!({ "comment_id": comment_id })))
}

// ─── 6. Delete Comment ──────────────────────────────────────────────────────

pub(crate) async fn delete_comment(
    State(state): State<Arc<AppState>>,
    Path((room_id, post_id, comment_id)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let user_id = validate_forum_member(&state, &headers, &room_id).await?;

    let coll = state.db.collection::<ForumCommentRecord>("forum_comments");
    let comment = coll
        .find_one(doc! { "_id": &comment_id, "post_id": &post_id, "deleted": false })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Comment not found"))?;

    if comment.author != user_id && !is_moderator_or_owner(&state, &room_id, &user_id).await {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "Only the author or a moderator can delete this comment",
        ));
    }

    let _ = coll
        .update_one(
            doc! { "_id": &comment_id },
            doc! { "$set": { "deleted": true } },
        )
        .await;

    // Decrement comment_count
    let posts_coll = state.db.collection::<ForumPostRecord>("forum_posts");
    let _ = posts_coll
        .update_one(
            doc! { "_id": &post_id },
            doc! { "$inc": { "comment_count": -1 } },
        )
        .await;

    let broadcast_msg = json!({
        "type": "forum.comment.deleted",
        "room_id": room_id,
        "post_id": post_id,
        "comment_id": comment_id,
    });
    broadcast_to_room(&state, &room_id, &broadcast_msg).await;

    Ok(Json(json!({ "deleted": true })))
}

// ─── 7. Edit Post ───────────────────────────────────────────────────────────

pub(crate) async fn edit_post(
    State(state): State<Arc<AppState>>,
    Path((room_id, post_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(req): Json<EditForumPostRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let user_id = validate_forum_member(&state, &headers, &room_id).await?;

    let coll = state.db.collection::<ForumPostRecord>("forum_posts");
    let post = coll
        .find_one(doc! { "_id": &post_id, "room_id": &room_id, "deleted": false })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Post not found"))?;

    if post.author != user_id {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "Only the author can edit this post",
        ));
    }

    let mut set_doc = mongodb::bson::Document::new();
    let new_title;
    let new_body;

    if let Some(ref title) = req.title {
        let trimmed = title.trim();
        if trimmed.is_empty() || trimmed.len() > 200 {
            return Err(error_response(
                StatusCode::BAD_REQUEST,
                "Title must be 1-200 characters",
            ));
        }
        set_doc.insert("title", trimmed);
        new_title = trimmed.to_string();
    } else {
        new_title = post.title.clone();
    }

    if let Some(ref body) = req.body {
        if body.len() > 4000 {
            return Err(error_response(
                StatusCode::BAD_REQUEST,
                "Body must be at most 4000 characters",
            ));
        }
        set_doc.insert("body", body.as_str());
        new_body = body.clone();
    } else {
        new_body = post.body.clone();
    }

    if set_doc.is_empty() {
        return Err(error_response(StatusCode::BAD_REQUEST, "Nothing to update"));
    }

    let now = now_millis();
    set_doc.insert("edited", true);
    set_doc.insert("edited_at", now);

    let _ = coll
        .update_one(doc! { "_id": &post_id }, doc! { "$set": set_doc })
        .await;

    let broadcast_msg = json!({
        "type": "forum.post.edited",
        "room_id": room_id,
        "post_id": post_id,
        "title": new_title,
        "body": new_body,
        "edited_at": now,
    });
    broadcast_to_room(&state, &room_id, &broadcast_msg).await;

    Ok(Json(json!({ "edited": true })))
}

// ─── 8. Edit Comment ────────────────────────────────────────────────────────

pub(crate) async fn edit_comment(
    State(state): State<Arc<AppState>>,
    Path((room_id, post_id, comment_id)): Path<(String, String, String)>,
    headers: HeaderMap,
    Json(req): Json<EditForumCommentRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let user_id = validate_forum_member(&state, &headers, &room_id).await?;

    let coll = state.db.collection::<ForumCommentRecord>("forum_comments");
    let comment = coll
        .find_one(doc! { "_id": &comment_id, "post_id": &post_id, "deleted": false })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Comment not found"))?;

    if comment.author != user_id {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "Only the author can edit this comment",
        ));
    }

    if req.body.trim().is_empty() || req.body.len() > 2000 {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "Comment body must be 1-2000 characters",
        ));
    }

    let now = now_millis();
    let _ = coll
        .update_one(
            doc! { "_id": &comment_id },
            doc! { "$set": { "body": &req.body, "edited": true, "edited_at": now } },
        )
        .await;

    let broadcast_msg = json!({
        "type": "forum.comment.edited",
        "room_id": room_id,
        "post_id": post_id,
        "comment_id": comment_id,
        "body": req.body,
        "edited_at": now,
    });
    broadcast_to_room(&state, &room_id, &broadcast_msg).await;

    Ok(Json(json!({ "edited": true })))
}

// ─── 9. Search Posts ────────────────────────────────────────────────────────

pub(crate) async fn search_posts(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<ForumSearchQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let _user_id = validate_forum_member(&state, &headers, &room_id).await?;

    let q = query.q.trim().to_lowercase();
    if q.is_empty() {
        return Ok(Json(json!({ "posts": [] })));
    }

    let limit = query.limit.unwrap_or(20).min(50) as usize;
    let coll = state.db.collection::<ForumPostRecord>("forum_posts");

    let filter = doc! { "room_id": &room_id, "deleted": false };
    let mut results: Vec<Value> = Vec::new();

    if let Ok(mut cursor) = coll.find(filter).sort(doc! { "last_activity": -1 }).await {
        while let Ok(Some(post)) = cursor.try_next().await {
            if results.len() >= limit {
                break;
            }
            if post.title.to_lowercase().contains(&q) || post.body.to_lowercase().contains(&q) {
                let reactions = get_reactions_for_event(&state, &post.post_id).await;
                results.push(post_to_json(&post, &reactions));
            }
        }
    }

    Ok(Json(json!({ "posts": results })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn urls(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_post_written_before_multiple_images_keeps_its_one() {
        assert_eq!(images_of("/external/a.png", &[]), urls(&["/external/a.png"]));
    }

    #[test]
    fn the_list_wins_once_a_post_has_one() {
        // Both fields are written now, and the single one is only the lead.
        assert_eq!(
            images_of("/external/a.png", &urls(&["/external/a.png", "/external/b.png"])),
            urls(&["/external/a.png", "/external/b.png"]),
        );
    }

    #[test]
    fn a_post_with_no_images_reads_as_empty_rather_than_one_blank() {
        assert!(images_of("", &[]).is_empty());
    }

    #[test]
    fn a_request_from_an_older_client_still_carries_its_image() {
        assert_eq!(
            requested_images(&Some("/external/a.png".into()), &None),
            urls(&["/external/a.png"]),
        );
    }

    #[test]
    fn a_request_sending_both_shapes_is_taken_as_the_list() {
        // The client sends image_url as a courtesy to older servers; taking it
        // as a separate image would duplicate the lead on every post.
        assert_eq!(
            requested_images(
                &Some("/external/a.png".into()),
                &Some(urls(&["/external/a.png", "/external/b.png"])),
            ),
            urls(&["/external/a.png", "/external/b.png"]),
        );
    }

    #[test]
    fn blanks_are_not_images() {
        assert!(requested_images(&Some(String::new()), &None).is_empty());
        assert!(requested_images(&None, &Some(urls(&["", "  "]))).is_empty());
        assert_eq!(
            requested_images(&None, &Some(urls(&["", "/external/b.png"]))),
            urls(&["/external/b.png"]),
        );
    }

    #[test]
    fn nothing_asked_for_is_nothing_stored() {
        assert!(requested_images(&None, &None).is_empty());
    }

    #[test]
    fn a_video_only_request_is_taken_whole() {
        assert_eq!(
            requested_media(&Some(urls(&["/external/a.mp4", " ", "/external/b.webm"]))),
            urls(&["/external/a.mp4", "/external/b.webm"]),
        );
        assert!(requested_media(&None).is_empty());
    }

    /// `id` replying to `parent`, deleted or not. Ordered oldest first by the
    /// caller, which is the order `get_post` reads them in.
    fn comment(id: &str, parent: &str, deleted: bool) -> ForumCommentRecord {
        ForumCommentRecord {
            comment_id: id.to_string(),
            post_id: "post_1".to_string(),
            room_id: "room_1".to_string(),
            author: "@a:localhost".to_string(),
            body: "hi".to_string(),
            image_url: String::new(),
            image_urls: Vec::new(),
            video_urls: Vec::new(),
            parent_id: parent.to_string(),
            created_at: 0,
            deleted,
            edited: false,
            edited_at: 0,
        }
    }

    fn kept(comments: &[ForumCommentRecord]) -> Vec<&str> {
        comments_worth_sending(comments)
            .into_iter()
            .zip(comments)
            .filter(|(keep, _)| *keep)
            .map(|(_, c)| c.comment_id.as_str())
            .collect()
    }

    #[test]
    fn a_deleted_comment_with_nothing_under_it_just_goes() {
        let comments = vec![comment("a", "", false), comment("b", "", true)];
        assert_eq!(kept(&comments), vec!["a"]);
    }

    #[test]
    fn a_deleted_comment_holding_up_a_reply_stays_as_a_tombstone() {
        let comments = vec![comment("a", "", true), comment("b", "a", false)];
        assert_eq!(kept(&comments), vec!["a", "b"]);
    }

    #[test]
    fn a_whole_deleted_branch_goes_together() {
        let comments = vec![
            comment("a", "", true),
            comment("b", "a", true),
            comment("c", "b", true),
        ];
        assert!(kept(&comments).is_empty());
    }

    #[test]
    fn one_living_leaf_keeps_every_tombstone_above_it() {
        // The survivor is three deep; without the chain it would be orphaned
        // out of the thread entirely.
        let comments = vec![
            comment("a", "", true),
            comment("b", "a", true),
            comment("c", "b", true),
            comment("d", "c", false),
        ];
        assert_eq!(kept(&comments), vec!["a", "b", "c", "d"]);
    }

    #[test]
    fn a_dead_branch_beside_a_living_one_still_goes() {
        let comments = vec![
            comment("root", "", false),
            comment("dead", "root", true),
            comment("dead_child", "dead", true),
            comment("alive", "root", false),
        ];
        assert_eq!(kept(&comments), vec!["root", "alive"]);
    }

    #[test]
    fn a_reply_whose_parent_was_never_fetched_is_still_its_own_business() {
        // Nothing to propagate to; it must not be dropped for want of a parent.
        let comments = vec![comment("orphan", "gone", false)];
        assert_eq!(kept(&comments), vec!["orphan"]);
    }
}
