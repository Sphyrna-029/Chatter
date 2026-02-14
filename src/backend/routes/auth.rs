use super::super::{
    dto::{LoginRequest, RegisterRequest},
    helpers::{
        error_response, extract_token, format_user_id, generate_id, generate_token,
        validate_username,
    },
    state::{AppState, UserRecord},
};
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::Json,
};
use serde_json::{json, Value};
use std::sync::Arc;

pub(crate) async fn register(
    State(state): State<Arc<AppState>>,
    Json(req): Json<RegisterRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let username = req.username.trim();
    if let Err(detail) = validate_username(username) {
        return Err(error_response(StatusCode::BAD_REQUEST, detail));
    }

    let user_id = format_user_id(username);

    let mut users = state.users.write().await;
    if users.contains_key(&user_id) {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "User already exists",
        ));
    }

    let token = generate_token();
    let device_id = req.device_id.unwrap_or_else(|| generate_id("DEVICE"));

    users.insert(
        user_id.clone(),
        UserRecord {
            password: req.password,
        },
    );
    drop(users);

    state
        .access_tokens
        .write()
        .await
        .insert(token.clone(), user_id.clone());

    Ok(Json(json!({
        "user_id": user_id,
        "access_token": token,
        "device_id": device_id
    })))
}

pub(crate) async fn login(
    State(state): State<Arc<AppState>>,
    Json(req): Json<LoginRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let username = req.username.trim();
    if let Err(detail) = validate_username(username) {
        return Err(error_response(StatusCode::BAD_REQUEST, detail));
    }

    let user_id = format_user_id(username);

    let users = state.users.read().await;
    match users.get(&user_id) {
        Some(u) if u.password == req.password => {}
        _ => return Err(error_response(StatusCode::FORBIDDEN, "Invalid credentials")),
    }
    drop(users);

    let token = generate_token();
    let device_id = req.device_id.unwrap_or_else(|| generate_id("DEVICE"));

    state
        .access_tokens
        .write()
        .await
        .insert(token.clone(), user_id.clone());

    Ok(Json(json!({
        "user_id": user_id,
        "access_token": token,
        "device_id": device_id
    })))
}

pub(crate) async fn logout(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;

    let user_id = {
        let tokens = state.access_tokens.read().await;
        tokens.get(&token).cloned()
    };

    if let Some(uid) = &user_id {
        state.active_websockets.write().await.remove(uid);
    }

    state.access_tokens.write().await.remove(&token);

    Ok(Json(json!({})))
}
