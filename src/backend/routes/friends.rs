use super::super::{
    dto::FriendActionRequest,
    helpers::{error_response, extract_token, generate_id, get_user_from_token, now_millis, send_to_user},
    state::{AppState, BlockRecord, FriendRequestRecord, FriendshipRecord, UserRecord},
};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::Json,
};
use futures_util::TryStreamExt;
use mongodb::bson::doc;
use serde_json::{json, Value};
use std::sync::Arc;

fn friendship_pair_key(a: &str, b: &str) -> String {
    if a < b {
        format!("{a}|{b}")
    } else {
        format!("{b}|{a}")
    }
}

fn sorted_pair(a: &str, b: &str) -> (String, String) {
    if a < b {
        (a.to_string(), b.to_string())
    } else {
        (b.to_string(), a.to_string())
    }
}

/// GET /api/friends — returns friends, incoming_requests, outgoing_requests, blocked
pub(crate) async fn get_friends(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    // Friends
    let friendships_coll = state.db.collection::<FriendshipRecord>("friendships");
    let mut friends = Vec::new();
    if let Ok(mut cursor) = friendships_coll
        .find(doc! { "$or": [{ "user_a": &user_id }, { "user_b": &user_id }] })
        .await
    {
        while let Ok(Some(f)) = cursor.try_next().await {
            let friend_id = if f.user_a == user_id { f.user_b } else { f.user_a };
            friends.push(friend_id);
        }
    }

    // Incoming requests
    let requests_coll = state.db.collection::<FriendRequestRecord>("friend_requests");
    let mut incoming = Vec::new();
    if let Ok(mut cursor) = requests_coll.find(doc! { "to_user": &user_id }).await {
        while let Ok(Some(r)) = cursor.try_next().await {
            incoming.push(json!({ "userId": r.from_user, "requestId": r.request_id }));
        }
    }

    // Outgoing requests
    let mut outgoing = Vec::new();
    if let Ok(mut cursor) = requests_coll.find(doc! { "from_user": &user_id }).await {
        while let Ok(Some(r)) = cursor.try_next().await {
            outgoing.push(json!({ "userId": r.to_user, "requestId": r.request_id }));
        }
    }

    // Blocked users
    let blocks_coll = state.db.collection::<BlockRecord>("blocks");
    let mut blocked = Vec::new();
    if let Ok(mut cursor) = blocks_coll.find(doc! { "blocker": &user_id }).await {
        while let Ok(Some(b)) = cursor.try_next().await {
            blocked.push(b.blocked);
        }
    }

    Ok(Json(json!({
        "friends": friends,
        "incoming_requests": incoming,
        "outgoing_requests": outgoing,
        "blocked": blocked,
    })))
}

/// GET /api/friends/status/:user_id
pub(crate) async fn get_friend_status(
    State(state): State<Arc<AppState>>,
    Path(target_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    // Check blocked
    let blocks_coll = state.db.collection::<BlockRecord>("blocks");
    if blocks_coll
        .find_one(doc! { "blocker": &user_id, "blocked": &target_id })
        .await
        .ok()
        .flatten()
        .is_some()
    {
        return Ok(Json(json!({ "status": "blocked" })));
    }
    if blocks_coll
        .find_one(doc! { "blocker": &target_id, "blocked": &user_id })
        .await
        .ok()
        .flatten()
        .is_some()
    {
        return Ok(Json(json!({ "status": "blocked_by" })));
    }

    // Check friends
    let pair = friendship_pair_key(&user_id, &target_id);
    let friendships_coll = state.db.collection::<FriendshipRecord>("friendships");
    if friendships_coll
        .find_one(doc! { "_id": &pair })
        .await
        .ok()
        .flatten()
        .is_some()
    {
        return Ok(Json(json!({ "status": "friends" })));
    }

    // Check pending requests
    let requests_coll = state.db.collection::<FriendRequestRecord>("friend_requests");
    if requests_coll
        .find_one(doc! { "from_user": &user_id, "to_user": &target_id })
        .await
        .ok()
        .flatten()
        .is_some()
    {
        return Ok(Json(json!({ "status": "request_sent" })));
    }
    if requests_coll
        .find_one(doc! { "from_user": &target_id, "to_user": &user_id })
        .await
        .ok()
        .flatten()
        .is_some()
    {
        return Ok(Json(json!({ "status": "request_received" })));
    }

    Ok(Json(json!({ "status": "none" })))
}

/// POST /api/friends/request
pub(crate) async fn send_friend_request(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<FriendActionRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;
    let target_id = &body.user_id;

    if user_id == *target_id {
        return Err(error_response(StatusCode::BAD_REQUEST, "Cannot friend yourself"));
    }

    // Target must exist
    let users_coll = state.db.collection::<UserRecord>("users");
    if users_coll
        .find_one(doc! { "_id": target_id })
        .await
        .ok()
        .flatten()
        .is_none()
    {
        return Err(error_response(StatusCode::NOT_FOUND, "User not found"));
    }

    // Check blocks
    let blocks_coll = state.db.collection::<BlockRecord>("blocks");
    if blocks_coll
        .find_one(doc! { "blocker": target_id, "blocked": &user_id })
        .await
        .ok()
        .flatten()
        .is_some()
    {
        return Err(error_response(StatusCode::FORBIDDEN, "Cannot send request to this user"));
    }
    if blocks_coll
        .find_one(doc! { "blocker": &user_id, "blocked": target_id })
        .await
        .ok()
        .flatten()
        .is_some()
    {
        return Err(error_response(StatusCode::BAD_REQUEST, "You have blocked this user"));
    }

    // Check already friends
    let pair = friendship_pair_key(&user_id, target_id);
    let friendships_coll = state.db.collection::<FriendshipRecord>("friendships");
    if friendships_coll
        .find_one(doc! { "_id": &pair })
        .await
        .ok()
        .flatten()
        .is_some()
    {
        return Err(error_response(StatusCode::BAD_REQUEST, "Already friends"));
    }

    let requests_coll = state.db.collection::<FriendRequestRecord>("friend_requests");

    // Check for reverse request (auto-accept)
    if let Some(reverse) = requests_coll
        .find_one(doc! { "from_user": target_id, "to_user": &user_id })
        .await
        .ok()
        .flatten()
    {
        // Auto-accept: delete the reverse request and create friendship
        let _ = requests_coll
            .delete_one(doc! { "_id": &reverse.request_id })
            .await;
        let (ua, ub) = sorted_pair(&user_id, target_id);
        let _ = friendships_coll
            .insert_one(FriendshipRecord {
                pair_key: pair,
                user_a: ua,
                user_b: ub,
                created_at: now_millis(),
            })
            .await;

        // Notify both users
        let event = json!({ "type": "friend_request_accepted", "user_id": &user_id });
        send_to_user(&state, target_id, &event).await;
        let event2 = json!({ "type": "friend_request_accepted", "user_id": target_id });
        send_to_user(&state, &user_id, &event2).await;

        return Ok(Json(json!({ "status": "friends", "auto_accepted": true })));
    }

    // Check duplicate pending
    if requests_coll
        .find_one(doc! { "from_user": &user_id, "to_user": target_id })
        .await
        .ok()
        .flatten()
        .is_some()
    {
        return Err(error_response(StatusCode::BAD_REQUEST, "Request already sent"));
    }

    // Create request
    let request_id = generate_id("fr");
    let _ = requests_coll
        .insert_one(FriendRequestRecord {
            request_id: request_id.clone(),
            from_user: user_id.clone(),
            to_user: target_id.clone(),
            created_at: now_millis(),
        })
        .await;

    // Notify target
    let event = json!({
        "type": "friend_request",
        "from_user": &user_id,
        "request_id": &request_id,
    });
    send_to_user(&state, target_id, &event).await;

    Ok(Json(json!({ "status": "request_sent" })))
}

/// POST /api/friends/accept
pub(crate) async fn accept_friend_request(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<FriendActionRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;
    let from_user = &body.user_id;

    let requests_coll = state.db.collection::<FriendRequestRecord>("friend_requests");
    let request = requests_coll
        .find_one(doc! { "from_user": from_user, "to_user": &user_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "No pending request from this user"))?;

    // Delete request
    let _ = requests_coll
        .delete_one(doc! { "_id": &request.request_id })
        .await;

    // Create friendship
    let pair = friendship_pair_key(&user_id, from_user);
    let (ua, ub) = sorted_pair(&user_id, from_user);
    let friendships_coll = state.db.collection::<FriendshipRecord>("friendships");
    let _ = friendships_coll
        .insert_one(FriendshipRecord {
            pair_key: pair,
            user_a: ua,
            user_b: ub,
            created_at: now_millis(),
        })
        .await;

    // Notify both
    let event = json!({ "type": "friend_request_accepted", "user_id": &user_id });
    send_to_user(&state, from_user, &event).await;
    let event2 = json!({ "type": "friend_request_accepted", "user_id": from_user });
    send_to_user(&state, &user_id, &event2).await;

    Ok(Json(json!({ "status": "friends" })))
}

/// POST /api/friends/reject
pub(crate) async fn reject_friend_request(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<FriendActionRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;
    let from_user = &body.user_id;

    let requests_coll = state.db.collection::<FriendRequestRecord>("friend_requests");
    let result = requests_coll
        .delete_one(doc! { "from_user": from_user, "to_user": &user_id })
        .await;

    if result.as_ref().map(|r| r.deleted_count).unwrap_or(0) == 0 {
        return Err(error_response(StatusCode::NOT_FOUND, "No pending request from this user"));
    }

    Ok(Json(json!({ "status": "rejected" })))
}

/// POST /api/friends/remove
pub(crate) async fn remove_friend(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<FriendActionRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;
    let target_id = &body.user_id;

    let pair = friendship_pair_key(&user_id, target_id);
    let friendships_coll = state.db.collection::<FriendshipRecord>("friendships");
    let result = friendships_coll.delete_one(doc! { "_id": &pair }).await;

    if result.as_ref().map(|r| r.deleted_count).unwrap_or(0) == 0 {
        return Err(error_response(StatusCode::NOT_FOUND, "Not friends with this user"));
    }

    // Notify the other user
    let event = json!({ "type": "friend_removed", "user_id": &user_id });
    send_to_user(&state, target_id, &event).await;

    Ok(Json(json!({ "status": "removed" })))
}

/// POST /api/friends/block
pub(crate) async fn block_user(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<FriendActionRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;
    let target_id = &body.user_id;

    if user_id == *target_id {
        return Err(error_response(StatusCode::BAD_REQUEST, "Cannot block yourself"));
    }

    let blocks_coll = state.db.collection::<BlockRecord>("blocks");

    // Check if already blocked
    if blocks_coll
        .find_one(doc! { "blocker": &user_id, "blocked": target_id })
        .await
        .ok()
        .flatten()
        .is_some()
    {
        return Err(error_response(StatusCode::BAD_REQUEST, "User already blocked"));
    }

    // Remove friendship if exists
    let pair = friendship_pair_key(&user_id, target_id);
    let friendships_coll = state.db.collection::<FriendshipRecord>("friendships");
    let was_friend = friendships_coll
        .delete_one(doc! { "_id": &pair })
        .await
        .map(|r| r.deleted_count > 0)
        .unwrap_or(false);

    // Cancel pending requests both directions
    let requests_coll = state.db.collection::<FriendRequestRecord>("friend_requests");
    let _ = requests_coll
        .delete_many(doc! { "$or": [
            { "from_user": &user_id, "to_user": target_id },
            { "from_user": target_id, "to_user": &user_id },
        ]})
        .await;

    // Create block
    let _ = blocks_coll
        .insert_one(BlockRecord {
            blocker: user_id.clone(),
            blocked: target_id.clone(),
            created_at: now_millis(),
        })
        .await;

    // Notify target if they were a friend
    if was_friend {
        let event = json!({ "type": "friend_removed", "user_id": &user_id });
        send_to_user(&state, target_id, &event).await;
    }

    Ok(Json(json!({ "status": "blocked" })))
}

/// POST /api/friends/unblock
pub(crate) async fn unblock_user(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<FriendActionRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;
    let target_id = &body.user_id;

    let blocks_coll = state.db.collection::<BlockRecord>("blocks");
    let result = blocks_coll
        .delete_one(doc! { "blocker": &user_id, "blocked": target_id })
        .await;

    if result.as_ref().map(|r| r.deleted_count).unwrap_or(0) == 0 {
        return Err(error_response(StatusCode::NOT_FOUND, "User is not blocked"));
    }

    Ok(Json(json!({ "status": "unblocked" })))
}
