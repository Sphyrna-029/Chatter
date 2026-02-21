use super::super::{
    dto::{LoginRequest, RefreshTokenRequest, RegisterRequest},
    helpers::{
        create_access_token, create_refresh_token, decode_token, error_response, extract_token,
        format_user_id, generate_id, get_user_from_token, hash_password, validate_username,
        verify_password,
    },
    state::{AppState, RefreshTokenRecord, UserRecord},
};
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::Json,
};
use mongodb::bson::doc;
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

    // Check if user exists in MongoDB
    let users = state.db.collection::<UserRecord>("users");
    if users
        .find_one(doc! { "_id": &user_id })
        .await
        .ok()
        .flatten()
        .is_some()
    {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "User already exists",
        ));
    }

    let password_hash = hash_password(&req.password);
    let device_id = req.device_id.unwrap_or_else(|| generate_id("DEVICE"));

    let user_record = UserRecord {
        user_id: user_id.clone(),
        password_hash,
        avatar_url: String::new(),
        about: String::new(),
    };
    users.insert_one(user_record).await.map_err(|_| {
        error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to create user",
        )
    })?;

    let access_token = create_access_token(&user_id, &state.jwt_secret);
    let refresh_token = create_refresh_token(&user_id, &state.jwt_secret);

    // Store refresh token in MongoDB
    store_refresh_token(&state, &refresh_token, &user_id).await;

    Ok(Json(json!({
        "user_id": user_id,
        "access_token": access_token,
        "refresh_token": refresh_token,
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

    let users = state.db.collection::<UserRecord>("users");
    let user = users
        .find_one(doc! { "_id": &user_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::FORBIDDEN, "Invalid credentials"))?;

    if !verify_password(&req.password, &user.password_hash) {
        return Err(error_response(StatusCode::FORBIDDEN, "Invalid credentials"));
    }

    let device_id = req.device_id.unwrap_or_else(|| generate_id("DEVICE"));
    let access_token = create_access_token(&user_id, &state.jwt_secret);
    let refresh_token = create_refresh_token(&user_id, &state.jwt_secret);

    store_refresh_token(&state, &refresh_token, &user_id).await;

    Ok(Json(json!({
        "user_id": user_id,
        "access_token": access_token,
        "refresh_token": refresh_token,
        "device_id": device_id
    })))
}

pub(crate) async fn logout(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;

    let user_id = get_user_from_token(&state, &token);

    if let Some(uid) = &user_id {
        state.active_websockets.write().await.remove(uid);

        // Delete all refresh tokens for this user
        let refresh_tokens = state
            .db
            .collection::<RefreshTokenRecord>("refresh_tokens");
        let _ = refresh_tokens.delete_many(doc! { "user_id": uid }).await;
    }

    Ok(Json(json!({})))
}

pub(crate) async fn refresh(
    State(state): State<Arc<AppState>>,
    Json(req): Json<RefreshTokenRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    // Decode the refresh token JWT
    let claims = decode_token(&req.refresh_token, &state.jwt_secret)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid or expired refresh token"))?;

    let user_id = claims.sub;

    // Check if refresh token exists in MongoDB (not revoked)
    let refresh_tokens = state
        .db
        .collection::<RefreshTokenRecord>("refresh_tokens");
    let found = refresh_tokens
        .find_one_and_delete(doc! { "token": &req.refresh_token })
        .await
        .ok()
        .flatten();

    if found.is_none() {
        return Err(error_response(
            StatusCode::UNAUTHORIZED,
            "Refresh token revoked or not found",
        ));
    }

    // Issue new token pair
    let new_access = create_access_token(&user_id, &state.jwt_secret);
    let new_refresh = create_refresh_token(&user_id, &state.jwt_secret);
    store_refresh_token(&state, &new_refresh, &user_id).await;

    Ok(Json(json!({
        "access_token": new_access,
        "refresh_token": new_refresh
    })))
}

async fn store_refresh_token(state: &AppState, token: &str, user_id: &str) {
    let collection = state
        .db
        .collection::<RefreshTokenRecord>("refresh_tokens");
    let record = RefreshTokenRecord {
        token: token.to_string(),
        user_id: user_id.to_string(),
        expires_at: chrono::Utc::now() + chrono::Duration::days(7),
    };
    let _ = collection.insert_one(record).await;
}
