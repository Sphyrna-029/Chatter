//! Enrolling and retiring browser push subscriptions.
//!
//! The client hands over whatever `PushManager.subscribe` gave it; the server
//! only stores it and later encrypts to it. Deciding *whether* a message is
//! worth a push lives in `backend/push.rs` alongside the delivery.

use super::super::{
    helpers::{error_response, extract_token, get_user_from_token, now_millis},
    push::{subscription_id, PushSubscriptionRecord},
    state::AppState,
};
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::Json,
};
use mongodb::bson::doc;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

#[derive(Deserialize)]
pub(crate) struct SubscriptionKeys {
    pub(crate) p256dh: String,
    pub(crate) auth: String,
}

#[derive(Deserialize)]
pub(crate) struct SubscribeRequest {
    pub(crate) endpoint: String,
    pub(crate) keys: SubscriptionKeys,
}

#[derive(Deserialize)]
pub(crate) struct UnsubscribeRequest {
    pub(crate) endpoint: String,
}

/// The public half of the server's VAPID key, which the browser needs before it
/// can subscribe at all.
///
/// `enabled: false` means this instance has no usable key; the client should
/// leave push switched off rather than offer a control that cannot work.
pub(crate) async fn push_public_key(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    match state.vapid.as_ref() {
        Some(vapid) => Ok(Json(json!({
            "enabled": true,
            "public_key": vapid.public_key,
        }))),
        None => Ok(Json(json!({ "enabled": false, "public_key": "" }))),
    }
}

/// Store a subscription for the caller.
///
/// Keyed by endpoint, so re-subscribing replaces rather than duplicates — and
/// so a second account signing in on the same browser takes the endpoint over
/// instead of both of them receiving each other's messages.
pub(crate) async fn push_subscribe(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<SubscribeRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    if req.endpoint.trim().is_empty()
        || req.keys.p256dh.trim().is_empty()
        || req.keys.auth.trim().is_empty()
    {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "endpoint, keys.p256dh and keys.auth are all required",
        ));
    }
    if !req.endpoint.starts_with("https://") {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "Push endpoint must be https",
        ));
    }

    let id = subscription_id(&req.endpoint);
    let _ = state
        .db
        .collection::<PushSubscriptionRecord>("push_subscriptions")
        .update_one(
            doc! { "_id": &id },
            doc! { "$set": {
                "user_id": &user_id,
                "endpoint": &req.endpoint,
                "p256dh": &req.keys.p256dh,
                "auth": &req.keys.auth,
                "created_at": now_millis(),
            }},
        )
        .upsert(true)
        .await;

    Ok(Json(json!({ "subscribed": true })))
}

/// Forget a subscription.
///
/// Scoped to the caller so one account cannot unsubscribe another's device,
/// even knowing its endpoint.
pub(crate) async fn push_unsubscribe(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<UnsubscribeRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let id = subscription_id(&req.endpoint);
    let _ = state
        .db
        .collection::<PushSubscriptionRecord>("push_subscriptions")
        .delete_one(doc! { "_id": &id, "user_id": &user_id })
        .await;

    Ok(Json(json!({ "subscribed": false })))
}
