use super::super::{
    dto::{CreateForumCommentRequest, CreateForumPostRequest, EditForumCommentRequest, EditForumPostRequest, ForumPostsQuery, ForumSearchQuery},
    helpers::{
        broadcast_to_room, error_response, extract_token, generate_id, get_user_from_token,
        is_moderator_or_owner, now_millis,
    },
    state::{AppState, ForumCommentRecord, ForumPostRecord, ReactionRecord, RoomRecord},
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

    if room.room_type != "forum" {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "Room is not a forum",
        ));
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

fn post_to_json(post: &ForumPostRecord, reactions: &HashMap<String, Vec<String>>) -> Value {
    json!({
        "post_id": post.post_id,
        "room_id": post.room_id,
        "author": post.author,
        "title": post.title,
        "body": post.body,
        "image_url": post.image_url,
        "created_at": post.created_at,
        "comment_count": post.comment_count,
        "last_activity": if post.last_activity > 0 { post.last_activity } else { post.created_at },
        "reactions": reactions,
        "edited": post.edited,
        "edited_at": post.edited_at,
    })
}

fn comment_to_json(comment: &ForumCommentRecord) -> Value {
    json!({
        "comment_id": comment.comment_id,
        "post_id": comment.post_id,
        "room_id": comment.room_id,
        "author": comment.author,
        "body": comment.body,
        "image_url": comment.image_url,
        "created_at": comment.created_at,
        "edited": comment.edited,
        "edited_at": comment.edited_at,
    })
}

async fn get_reactions_for_event(
    state: &AppState,
    event_id: &str,
) -> HashMap<String, Vec<String>> {
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

    let post_id = generate_id("post_");
    let now = now_millis();
    let post = ForumPostRecord {
        post_id: post_id.clone(),
        room_id: room_id.clone(),
        author: user_id.clone(),
        title: title.clone(),
        body: req.body.clone(),
        image_url: req.image_url.clone().unwrap_or_default(),
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

    // Also fetch comments
    let comments_coll = state.db.collection::<ForumCommentRecord>("forum_comments");
    let mut comments: Vec<Value> = Vec::new();
    if let Ok(mut cursor) = comments_coll
        .find(doc! { "post_id": &post_id, "deleted": false })
        .sort(doc! { "created_at": 1 })
        .await
    {
        while let Ok(Some(comment)) = cursor.try_next().await {
            comments.push(comment_to_json(&comment));
        }
    }

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

    let comment_id = generate_id("cmt_");
    let now = now_millis();
    let comment = ForumCommentRecord {
        comment_id: comment_id.clone(),
        post_id: post_id.clone(),
        room_id: room_id.clone(),
        author: user_id.clone(),
        body: req.body.clone(),
        image_url: req.image_url.clone().unwrap_or_default(),
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
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "Nothing to update",
        ));
    }

    let now = now_millis();
    set_doc.insert("edited", true);
    set_doc.insert("edited_at", now);

    let _ = coll
        .update_one(
            doc! { "_id": &post_id },
            doc! { "$set": set_doc },
        )
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

    if let Ok(mut cursor) = coll
        .find(filter)
        .sort(doc! { "last_activity": -1 })
        .await
    {
        while let Ok(Some(post)) = cursor.try_next().await {
            if results.len() >= limit {
                break;
            }
            if post.title.to_lowercase().contains(&q)
                || post.body.to_lowercase().contains(&q)
            {
                let reactions = get_reactions_for_event(&state, &post.post_id).await;
                results.push(post_to_json(&post, &reactions));
            }
        }
    }

    Ok(Json(json!({ "posts": results })))
}
