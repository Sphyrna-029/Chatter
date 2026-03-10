use super::super::{
    dto::{
        ChangePasswordRequest, CheckUsernameRequest, DeleteAccountRequest, LoginRequest,
        RecoveryCodesRequest, RefreshTokenRequest, RegisterRequest, TotpVerifyRequest,
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
use sha2::{Sha256, Digest};
use std::sync::Arc;
use totp_rs::{Algorithm, Secret, TOTP};

fn build_totp(secret_base32: &str, username: &str) -> Result<TOTP, String> {
    let secret_bytes = Secret::Encoded(secret_base32.to_string())
        .to_bytes()
        .map_err(|e| format!("Invalid TOTP secret: {}", e))?;
    TOTP::new(Algorithm::SHA1, 6, 1, 30, secret_bytes, Some("Chatter".to_string()), username.to_string())
        .map_err(|e| format!("TOTP error: {}", e))
}

fn hash_recovery_code(code: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(code.as_bytes());
    hex::encode(hasher.finalize())
}

fn generate_recovery_codes(count: usize) -> (Vec<String>, Vec<String>) {
    use rand::Rng;
    let chars: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let mut rng = rand::thread_rng();
    let mut plaintext = Vec::with_capacity(count);
    let mut hashed = Vec::with_capacity(count);
    for _ in 0..count {
        let code: String = (0..8).map(|_| chars[rng.gen_range(0..chars.len())] as char).collect();
        let hash = hash_recovery_code(&code);
        plaintext.push(code);
        hashed.push(hash);
    }
    (plaintext, hashed)
}

/// Try TOTP first, then recovery codes. Returns Ok(true) if recovery code was used (and consumed).
async fn verify_totp_or_recovery(
    code: &str,
    user: &UserRecord,
    username: &str,
    state: &AppState,
) -> Result<bool, (StatusCode, Json<Value>)> {
    // Try TOTP first
    if let Ok(totp) = build_totp(&user.totp_secret, username) {
        if totp.check_current(code).unwrap_or(false) {
            return Ok(false);
        }
    }

    // Try recovery codes
    let code_hash = hash_recovery_code(&code.to_uppercase());
    if let Some(pos) = user.recovery_codes.iter().position(|h| h == &code_hash) {
        // Remove used recovery code from DB
        let mut remaining = user.recovery_codes.clone();
        remaining.remove(pos);
        let users = state.db.collection::<UserRecord>("users");
        let bson_codes: Vec<mongodb::bson::Bson> = remaining.iter().map(|s| mongodb::bson::Bson::String(s.clone())).collect();
        let _ = users
            .update_one(
                doc! { "_id": &user.user_id },
                doc! { "$set": { "recovery_codes": bson_codes } },
            )
            .await;
        return Ok(true);
    }

    Err(error_response(StatusCode::FORBIDDEN, "Invalid TOTP code"))
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

/// GET /api/server/info
pub(crate) async fn server_info(
    State(state): State<Arc<AppState>>,
) -> Json<Value> {
    let settings = state.server_settings.read().await;
    Json(json!({ "invite_only": settings.invite_only, "require_auth_for_uploads": settings.require_auth_for_uploads }))
}

pub(crate) async fn register(
    State(state): State<Arc<AppState>>,
    Json(req): Json<RegisterRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    // Check invite-only mode
    {
        let settings = state.server_settings.read().await;
        if settings.invite_only {
            match &req.invite_code {
                Some(code) if code == &settings.invite_code => {}
                _ => return Err(error_response(StatusCode::FORBIDDEN, "Valid invite code required")),
            }
        }
    }

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

    // First user to register becomes admin
    let user_count = users.count_documents(doc! {}).await.unwrap_or(0);
    let is_admin = user_count == 0;

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
        recovery_codes: Vec::new(),
        custom_status: String::new(),
        manual_status: None,
        is_admin,
        disabled: false,
        name_font_url: String::new(),
    };
    users.insert_one(user_record).await.map_err(|_| {
        error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to create user",
        )
    })?;

    // Build TOTP URI for QR code
    let totp = build_totp(&totp_secret, username)
        .map_err(|e| error_response(StatusCode::INTERNAL_SERVER_ERROR, &e))?;
    let totp_uri = totp.get_url();

    // Generate QR code as base64 PNG
    let qr_base64 = totp.get_qr_base64().unwrap_or_default();

    // Don't issue tokens yet - user must verify TOTP first
    Ok(Json(json!({
        "user_id": user_id,
        "totp_secret": totp_secret,
        "totp_uri": totp_uri,
        "totp_qr_base64": qr_base64,
        "is_admin": is_admin
    })))
}

pub(crate) async fn totp_verify(
    State(state): State<Arc<AppState>>,
    Json(req): Json<TotpVerifyRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let user_id = req.user_id;

    // Rate limit: max 5 attempts per 5-minute window per user_id
    {
        use super::super::helpers::now_secs;
        use super::super::state::TotpAttemptRecord;
        let now = now_secs();
        let window = 300.0; // 5 minutes
        let max_attempts = 5u32;

        let mut attempts = state.totp_attempts.write().await;
        let entry = attempts.entry(user_id.clone()).or_insert(TotpAttemptRecord {
            count: 0,
            window_start: now,
        });

        if now - entry.window_start > window {
            // Reset window
            entry.count = 0;
            entry.window_start = now;
        }

        if entry.count >= max_attempts {
            return Err(error_response(
                StatusCode::TOO_MANY_REQUESTS,
                "Too many TOTP attempts. Try again in a few minutes.",
            ));
        }

        entry.count += 1;
    }

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

    // Clear attempts on success
    {
        let mut attempts = state.totp_attempts.write().await;
        attempts.remove(&user_id);
    }

    // Mark TOTP as verified and generate recovery codes
    let (plaintext_codes, hashed_codes) = generate_recovery_codes(5);
    let bson_codes: Vec<mongodb::bson::Bson> = hashed_codes.iter().map(|s| mongodb::bson::Bson::String(s.clone())).collect();
    let _ = users
        .update_one(
            doc! { "_id": &user_id },
            doc! { "$set": { "totp_verified": true, "recovery_codes": bson_codes } },
        )
        .await;

    // Now that TOTP is verified, issue tokens
    let access_token = create_access_token(&user_id, &state.jwt_secret);
    let refresh_token = create_refresh_token(&user_id, &state.jwt_secret);
    store_refresh_token(&state, &refresh_token, &user_id).await;

    Ok(Json(json!({
        "verified": true,
        "recovery_codes": plaintext_codes,
        "access_token": access_token,
        "refresh_token": refresh_token,
        "user_id": user_id,
        "is_admin": user.is_admin,
        "totp_verified": true
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

    // Reject disabled accounts
    if user.disabled {
        return Err(error_response(StatusCode::FORBIDDEN, "Account is disabled"));
    }

    // Auto-promote: if no admin exists yet, make this user admin (handles pre-existing DBs)
    let mut is_admin = user.is_admin;
    if !is_admin {
        let admin_count = users
            .count_documents(doc! { "is_admin": true })
            .await
            .unwrap_or(1);
        if admin_count == 0 {
            let _ = users
                .update_one(doc! { "_id": &user_id }, doc! { "$set": { "is_admin": true } })
                .await;
            is_admin = true;
        }
    }

    // If TOTP is set up and verified, require a TOTP code or recovery code
    if user.totp_verified && !user.totp_secret.is_empty() {
        match &req.totp_code {
            None => {
                return Ok(Json(json!({ "requires_totp": true })));
            }
            Some(code) => {
                verify_totp_or_recovery(code, &user, username, &state).await?;
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
        "device_id": device_id,
        "is_admin": is_admin,
        "totp_verified": user.totp_verified
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

    // Verify TOTP or recovery code
    let username = user_id.split(':').next().unwrap_or(&user_id).trim_start_matches('@');
    verify_totp_or_recovery(&req.totp_code, &user, username, &state).await?;

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

    // Verify TOTP or recovery code
    let username = user_id.split(':').next().unwrap_or(&user_id).trim_start_matches('@');
    verify_totp_or_recovery(&req.totp_code, &user, username, &state).await?;

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

    // Look up user to include is_admin and totp_verified
    let users = state.db.collection::<UserRecord>("users");
    let user = users
        .find_one(doc! { "_id": &user_id })
        .await
        .ok()
        .flatten();
    let is_admin = user.as_ref().map(|u| u.is_admin).unwrap_or(false);
    let totp_verified = user.as_ref().map(|u| u.totp_verified).unwrap_or(false);

    // Issue new token pair
    let new_access = create_access_token(&user_id, &state.jwt_secret);
    let new_refresh = create_refresh_token(&user_id, &state.jwt_secret);
    store_refresh_token(&state, &new_refresh, &user_id).await;

    Ok(Json(json!({
        "access_token": new_access,
        "refresh_token": new_refresh,
        "is_admin": is_admin,
        "totp_verified": totp_verified
    })))
}

pub(crate) async fn get_recovery_codes(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<RecoveryCodesRequest>,
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

    // Verify TOTP code (not recovery code - must use real TOTP)
    let username = user_id.split(':').next().unwrap_or(&user_id).trim_start_matches('@');
    let totp = build_totp(&user.totp_secret, username)
        .map_err(|e| error_response(StatusCode::INTERNAL_SERVER_ERROR, &e))?;
    if !totp.check_current(&req.totp_code).unwrap_or(false) {
        return Err(error_response(StatusCode::FORBIDDEN, "Invalid TOTP code"));
    }

    // Generate new recovery codes (replaces old ones)
    let (plaintext_codes, hashed_codes) = generate_recovery_codes(5);
    let bson_codes: Vec<mongodb::bson::Bson> = hashed_codes.iter().map(|s| mongodb::bson::Bson::String(s.clone())).collect();
    let _ = users
        .update_one(
            doc! { "_id": &user_id },
            doc! { "$set": { "recovery_codes": bson_codes } },
        )
        .await;

    Ok(Json(json!({ "recovery_codes": plaintext_codes })))
}

pub(crate) async fn totp_setup(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
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

    if user.totp_verified {
        return Err(error_response(StatusCode::BAD_REQUEST, "2FA is already set up"));
    }

    // Generate a new 20-byte TOTP secret
    let mut secret_bytes = [0u8; 20];
    rand::Rng::fill(&mut rand::thread_rng(), &mut secret_bytes[..]);
    let totp_secret = Secret::Raw(secret_bytes.to_vec()).to_encoded().to_string();

    // Save the new secret to DB
    let _ = users
        .update_one(
            doc! { "_id": &user_id },
            doc! { "$set": { "totp_secret": &totp_secret } },
        )
        .await;

    let username = user_id.split(':').next().unwrap_or(&user_id).trim_start_matches('@');
    let totp = build_totp(&totp_secret, username)
        .map_err(|e| error_response(StatusCode::INTERNAL_SERVER_ERROR, &e))?;
    let totp_uri = totp.get_url();
    let qr_base64 = totp.get_qr_base64().unwrap_or_default();

    Ok(Json(json!({
        "totp_secret": totp_secret,
        "totp_uri": totp_uri,
        "totp_qr_base64": qr_base64
    })))
}

pub(crate) async fn account_status(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
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

    Ok(Json(json!({
        "totp_verified": user.totp_verified
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
