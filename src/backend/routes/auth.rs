use super::super::{
    dto::{
        ChangePasswordRequest, CheckUsernameRequest, DeleteAccountRequest, LoginRequest,
        RefreshTokenRequest, RegisterRequest, TotpVerifyRequest,
    },
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
use totp_rs::{Algorithm, Secret, TOTP};

fn build_totp(secret_base32: &str, username: &str) -> Result<TOTP, String> {
    let secret_bytes = Secret::Encoded(secret_base32.to_string())
        .to_bytes()
        .map_err(|e| format!("Invalid TOTP secret: {}", e))?;
    TOTP::new(Algorithm::SHA1, 6, 1, 30, secret_bytes, Some("Chatter".to_string()), username.to_string())
        .map_err(|e| format!("TOTP error: {}", e))
}

pub(crate) async fn check_username(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CheckUsernameRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let username = req.username.trim();
    if let Err(detail) = validate_username(username) {
        return Err(error_response(StatusCode::BAD_REQUEST, detail));
    }

    let user_id = format_user_id(username);
    let users = state.db.collection::<UserRecord>("users");
    let exists = users
        .find_one(doc! { "_id": &user_id })
        .await
        .ok()
        .flatten()
        .is_some();

    Ok(Json(json!({ "available": !exists })))
}

pub(crate) async fn register(
    State(state): State<Arc<AppState>>,
    Json(req): Json<RegisterRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let username = req.username.trim();
    if let Err(detail) = validate_username(username) {
        return Err(error_response(StatusCode::BAD_REQUEST, detail));
    }

    // Validate password confirmation if provided
    if let Some(ref confirm) = req.password_confirm {
        if confirm != &req.password {
            return Err(error_response(StatusCode::BAD_REQUEST, "Passwords do not match"));
        }
    }

    if req.password.len() < 6 {
        return Err(error_response(StatusCode::BAD_REQUEST, "Password must be at least 6 characters"));
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

    // Generate TOTP secret (20 random bytes, base32-encoded)
    let mut secret_bytes = [0u8; 20];
    rand::Rng::fill(&mut rand::thread_rng(), &mut secret_bytes[..]);
    let totp_secret = Secret::Raw(secret_bytes.to_vec()).to_encoded().to_string();

    let user_record = UserRecord {
        user_id: user_id.clone(),
        password_hash,
        avatar_url: String::new(),
        about: String::new(),
        banner_url: String::new(),
        display_name: String::new(),
        totp_secret: totp_secret.clone(),
        totp_verified: false,
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

    // Build TOTP URI for QR code
    let totp = build_totp(&totp_secret, username)
        .map_err(|e| error_response(StatusCode::INTERNAL_SERVER_ERROR, &e))?;
    let totp_uri = totp.get_url();

    // Generate QR code as base64 PNG
    let qr_base64 = totp.get_qr_base64().unwrap_or_default();

    Ok(Json(json!({
        "user_id": user_id,
        "access_token": access_token,
        "refresh_token": refresh_token,
        "device_id": device_id,
        "totp_secret": totp_secret,
        "totp_uri": totp_uri,
        "totp_qr_base64": qr_base64
    })))
}

pub(crate) async fn totp_verify(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<TotpVerifyRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let users = state.db.collection::<UserRecord>("users");
    let user = users
        .find_one(doc! { "_id": &user_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "User not found"))?;

    if user.totp_secret.is_empty() {
        return Err(error_response(StatusCode::BAD_REQUEST, "TOTP not configured"));
    }

    let username = user_id.split(':').next().unwrap_or(&user_id).trim_start_matches('@');
    let totp = build_totp(&user.totp_secret, username)
        .map_err(|e| error_response(StatusCode::INTERNAL_SERVER_ERROR, &e))?;

    if !totp.check_current(&req.code).unwrap_or(false) {
        return Err(error_response(StatusCode::FORBIDDEN, "Invalid TOTP code"));
    }

    // Mark TOTP as verified
    let _ = users
        .update_one(
            doc! { "_id": &user_id },
            doc! { "$set": { "totp_verified": true } },
        )
        .await;

    Ok(Json(json!({ "verified": true })))
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

    // If TOTP is set up and verified, require a TOTP code
    if user.totp_verified && !user.totp_secret.is_empty() {
        match &req.totp_code {
            None => {
                return Ok(Json(json!({ "requires_totp": true })));
            }
            Some(code) => {
                let totp = build_totp(&user.totp_secret, username)
                    .map_err(|e| error_response(StatusCode::INTERNAL_SERVER_ERROR, &e))?;
                if !totp.check_current(code).unwrap_or(false) {
                    return Err(error_response(StatusCode::FORBIDDEN, "Invalid TOTP code"));
                }
            }
        }
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

pub(crate) async fn change_password(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<ChangePasswordRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    if req.new_password.len() < 6 {
        return Err(error_response(StatusCode::BAD_REQUEST, "Password must be at least 6 characters"));
    }

    let users = state.db.collection::<UserRecord>("users");
    let user = users
        .find_one(doc! { "_id": &user_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "User not found"))?;

    // Verify TOTP
    let username = user_id.split(':').next().unwrap_or(&user_id).trim_start_matches('@');
    let totp = build_totp(&user.totp_secret, username)
        .map_err(|e| error_response(StatusCode::INTERNAL_SERVER_ERROR, &e))?;
    if !totp.check_current(&req.totp_code).unwrap_or(false) {
        return Err(error_response(StatusCode::FORBIDDEN, "Invalid TOTP code"));
    }

    let new_hash = hash_password(&req.new_password);
    let _ = users
        .update_one(
            doc! { "_id": &user_id },
            doc! { "$set": { "password_hash": new_hash } },
        )
        .await;

    Ok(Json(json!({ "success": true })))
}

pub(crate) async fn delete_account(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<DeleteAccountRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let users = state.db.collection::<UserRecord>("users");
    let user = users
        .find_one(doc! { "_id": &user_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "User not found"))?;

    // Verify TOTP
    let username = user_id.split(':').next().unwrap_or(&user_id).trim_start_matches('@');
    let totp = build_totp(&user.totp_secret, username)
        .map_err(|e| error_response(StatusCode::INTERNAL_SERVER_ERROR, &e))?;
    if !totp.check_current(&req.totp_code).unwrap_or(false) {
        return Err(error_response(StatusCode::FORBIDDEN, "Invalid TOTP code"));
    }

    // Remove user from all rooms (room_members collection)
    let room_members = state.db.collection::<mongodb::bson::Document>("room_members");
    let _ = room_members.delete_many(doc! { "user_id": &user_id }).await;

    // Update room_members cache
    {
        let mut rm = state.room_members.write().await;
        for members in rm.values_mut() {
            members.retain(|m| m != &user_id);
        }
    }

    // Remove from room_roles cache
    {
        let mut roles = state.room_roles.write().await;
        for role_map in roles.values_mut() {
            role_map.remove(&user_id);
        }
    }

    // Delete refresh tokens
    let refresh_tokens = state.db.collection::<RefreshTokenRecord>("refresh_tokens");
    let _ = refresh_tokens.delete_many(doc! { "user_id": &user_id }).await;

    // Close active WebSocket
    state.active_websockets.write().await.remove(&user_id);

    // Remove presence
    state.user_presence.write().await.remove(&user_id);

    // Delete user record
    let _ = users.delete_one(doc! { "_id": &user_id }).await;

    Ok(Json(json!({ "deleted": true })))
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
