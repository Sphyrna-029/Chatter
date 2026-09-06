use super::super::{
    dto::{
        ChangePasswordRequest, CheckUsernameRequest, DeleteAccountRequest,
        ForceResetPasswordRequest, LoginRequest, RecoveryCodesRequest, RecoveryLoginRequest,
        RefreshTokenRequest, RegisterRequest, TotpVerifyRequest,
    },
    helpers::{
        auth_cookie_headers, clear_cookie_headers, create_access_token, create_refresh_token,
        decode_token, error_response, extract_refresh_cookie, extract_token, format_user_id,
        generate_id, get_user_from_token, hash_password, rate_limited, validate_username,
        verify_password,
    },
    ratelimit,
    state::{AppState, PendingRegistration, RefreshTokenRecord, UserRecord},
};
use axum::{
    extract::{ConnectInfo, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Json},
};
use mongodb::bson::doc;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::net::SocketAddr;
use std::sync::Arc;
use totp_rs::{Algorithm, Secret, TOTP};

fn build_totp(secret_base32: &str, username: &str) -> Result<TOTP, String> {
    let secret_bytes = Secret::Encoded(secret_base32.to_string())
        .to_bytes()
        .map_err(|e| format!("Invalid TOTP secret: {}", e))?;
    TOTP::new(
        Algorithm::SHA1,
        6,
        1,
        30,
        secret_bytes,
        Some("Chatter".to_string()),
        username.to_string(),
    )
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
        let code: String = (0..8)
            .map(|_| chars[rng.gen_range(0..chars.len())] as char)
            .collect();
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
        let bson_codes: Vec<mongodb::bson::Bson> = remaining
            .iter()
            .map(|s| mongodb::bson::Bson::String(s.clone()))
            .collect();
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
    let exists_in_db = users
        .find_one(doc! { "_id": &user_id })
        .await
        .ok()
        .flatten()
        .is_some();
    let exists_pending = {
        use super::super::helpers::now_secs;
        let mut pending = state.pending_registrations.write().await;
        let now = now_secs();
        pending.retain(|_, p| now - p.created_at < 600.0);
        pending.contains_key(&user_id)
    };

    Ok(Json(
        json!({ "available": !exists_in_db && !exists_pending }),
    ))
}

/// GET /api/server/info
pub(crate) async fn server_info(State(state): State<Arc<AppState>>) -> Json<Value> {
    let settings = state.server_settings.read().await;
    Json(
        json!({ "invite_only": settings.invite_only, "require_auth_for_uploads": settings.require_auth_for_uploads, "storage_limit_bytes": settings.storage_limit_bytes, "upload_limit_bytes": settings.upload_limit_bytes }),
    )
}

/// GET /api/ice-servers — returns ICE server config (STUN + TURN) for client WebRTC
pub(crate) async fn ice_servers(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let mut servers = vec![json!({ "urls": ["stun:stun.l.google.com:19302"] })];

    // TURN_PUBLIC_URL is the client-facing TURN address (e.g. turn:yourdomain.com:3478).
    // Falls back to TURN_URL if not set (works when TURN_URL is already public).
    let turn_url = std::env::var("TURN_PUBLIC_URL")
        .or_else(|_| std::env::var("TURN_URL"))
        .unwrap_or_default();

    if !turn_url.is_empty() {
        let username = std::env::var("TURN_USERNAME").unwrap_or_default();
        let credential = std::env::var("TURN_PASSWORD").unwrap_or_default();
        let client_urls: Vec<String> = turn_url.split(',').map(|s| s.trim().to_string()).collect();
        servers.push(json!({
            "urls": client_urls,
            "username": username,
            "credential": credential,
        }));
    }

    Ok(Json(json!({ "iceServers": servers })))
}

pub(crate) async fn register(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<RegisterRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    // Two buckets, because neither alone is enough. The per-address one keeps
    // one client from making accounts in a loop; the instance-wide one holds
    // even when the address cannot be trusted (see REGISTER_GLOBAL).
    if let Err(retry_after) =
        ratelimit::check(&state, "register:global", ratelimit::REGISTER_GLOBAL).await
    {
        return Err(rate_limited(
            retry_after,
            "This server is receiving too many registrations right now",
        ));
    }
    let ip = extract_ip(&headers, Some(peer));
    if let Err(retry_after) =
        ratelimit::check(&state, &format!("register:{ip}"), ratelimit::REGISTER).await
    {
        return Err(rate_limited(
            retry_after,
            "Too many accounts created from this address",
        ));
    }

    // Check invite-only mode
    {
        let settings = state.server_settings.read().await;
        if settings.invite_only {
            match &req.invite_code {
                Some(code) if code == &settings.invite_code => {}
                _ => {
                    return Err(error_response(
                        StatusCode::FORBIDDEN,
                        "Valid invite code required",
                    ))
                }
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
            return Err(error_response(
                StatusCode::BAD_REQUEST,
                "Passwords do not match",
            ));
        }
    }

    if req.password.len() < 6 {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "Password must be at least 6 characters",
        ));
    }
    if req.password.len() > 64 {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "Password must be at most 64 characters",
        ));
    }

    let user_id = format_user_id(username);

    // Check if user exists in MongoDB or is pending TOTP verification
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

    // First user to register becomes admin (count existing + pending)
    let user_count = users.count_documents(doc! {}).await.unwrap_or(0);
    let pending_count = state.pending_registrations.read().await.len() as u64;
    let is_admin = user_count == 0 && pending_count == 0;

    // Generate TOTP secret (20 random bytes, base32-encoded)
    let mut secret_bytes = [0u8; 20];
    rand::Rng::fill(&mut rand::thread_rng(), &mut secret_bytes[..]);
    let totp_secret = Secret::Raw(secret_bytes.to_vec()).to_encoded().to_string();

    // Store in pending registrations instead of creating the user in DB.
    // The user will be persisted only after successful TOTP verification.
    {
        use super::super::helpers::now_secs;
        let mut pending = state.pending_registrations.write().await;

        // Clean up stale pending registrations older than 10 minutes
        let now = now_secs();
        pending.retain(|_, p| now - p.created_at < 600.0);

        pending.insert(
            user_id.clone(),
            PendingRegistration {
                password_hash,
                totp_secret: totp_secret.clone(),
                is_admin,
                created_at: now,
            },
        );
    }

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
) -> Result<impl IntoResponse, (StatusCode, Json<Value>)> {
    let user_id = req.user_id;

    // Rate limit: max 5 attempts per 5-minute window per user_id
    {
        use super::super::helpers::now_secs;
        use super::super::state::TotpAttemptRecord;
        let now = now_secs();
        let window = 300.0; // 5 minutes
        let max_attempts = 5u32;

        let mut attempts = state.totp_attempts.write().await;
        let entry = attempts
            .entry(user_id.clone())
            .or_insert(TotpAttemptRecord {
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

    // Check if this is a pending registration (account not yet created)
    let pending = {
        use super::super::helpers::now_secs;
        let mut pending_map = state.pending_registrations.write().await;
        let now = now_secs();
        pending_map.retain(|_, p| now - p.created_at < 600.0);
        pending_map.get(&user_id).cloned()
    };

    if let Some(pending_reg) = pending {
        // Verify TOTP against the pending registration's secret
        let username = user_id
            .split(':')
            .next()
            .unwrap_or(&user_id)
            .trim_start_matches('@');
        let totp = build_totp(&pending_reg.totp_secret, username)
            .map_err(|e| error_response(StatusCode::INTERNAL_SERVER_ERROR, &e))?;

        if !totp.check_current(&req.code).unwrap_or(false) {
            return Err(error_response(StatusCode::FORBIDDEN, "Invalid TOTP code"));
        }

        // Clear attempts on success
        {
            let mut attempts = state.totp_attempts.write().await;
            attempts.remove(&user_id);
        }

        // Generate recovery codes
        let (plaintext_codes, hashed_codes) = generate_recovery_codes(5);

        // NOW create the user in the database
        let users = state.db.collection::<UserRecord>("users");
        let user_record = UserRecord {
            user_id: user_id.clone(),
            password_hash: pending_reg.password_hash,
            avatar_url: String::new(),
            about: String::new(),
            banner_url: String::new(),
            display_name: String::new(),
            totp_secret: pending_reg.totp_secret,
            totp_verified: true,
            recovery_codes: hashed_codes,
            custom_status: String::new(),
            manual_status: None,
            entrance_sound_url: String::new(),
            is_admin: pending_reg.is_admin,
            disabled: false,
            name_font_url: String::new(),
            must_reset_password: false,
            steam_id: None,
            hide_steam_game: false,
            spotify_refresh_token: None,
            hide_spotify: false,
        };
        users.insert_one(user_record).await.map_err(|_| {
            error_response(StatusCode::INTERNAL_SERVER_ERROR, "Failed to create user")
        })?;

        // Remove from pending registrations
        {
            let mut pending_map = state.pending_registrations.write().await;
            pending_map.remove(&user_id);
        }

        // Issue tokens
        let access_token = create_access_token(&user_id, &state.jwt_secret);
        let refresh_token = create_refresh_token(&user_id, &state.jwt_secret);
        store_refresh_token(&state, &refresh_token, &user_id, "Unknown", "Unknown").await;

        return Ok((
            auth_cookie_headers(&access_token, &refresh_token),
            Json(json!({
                "verified": true,
                "recovery_codes": plaintext_codes,
                "access_token": access_token,
                "refresh_token": refresh_token,
                "user_id": user_id,
                "is_admin": pending_reg.is_admin,
                "totp_verified": true
            })),
        )
            .into_response());
    }

    // Existing user flow (e.g. TOTP setup for existing accounts)
    let users = state.db.collection::<UserRecord>("users");
    let user = users
        .find_one(doc! { "_id": &user_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "User not found"))?;

    if user.totp_secret.is_empty() {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "TOTP not configured",
        ));
    }

    let username = user_id
        .split(':')
        .next()
        .unwrap_or(&user_id)
        .trim_start_matches('@');
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
    let bson_codes: Vec<mongodb::bson::Bson> = hashed_codes
        .iter()
        .map(|s| mongodb::bson::Bson::String(s.clone()))
        .collect();
    let _ = users
        .update_one(
            doc! { "_id": &user_id },
            doc! { "$set": { "totp_verified": true, "recovery_codes": bson_codes } },
        )
        .await;

    // Now that TOTP is verified, issue tokens
    let access_token = create_access_token(&user_id, &state.jwt_secret);
    let refresh_token = create_refresh_token(&user_id, &state.jwt_secret);
    store_refresh_token(&state, &refresh_token, &user_id, "Unknown", "Unknown").await;

    Ok((
        auth_cookie_headers(&access_token, &refresh_token),
        Json(json!({
            "verified": true,
            "recovery_codes": plaintext_codes,
            "access_token": access_token,
            "refresh_token": refresh_token,
            "user_id": user_id,
            "is_admin": user.is_admin,
            "totp_verified": true
        })),
    )
        .into_response())
}

pub(crate) async fn login(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<LoginRequest>,
) -> Result<impl IntoResponse, (StatusCode, Json<Value>)> {
    let username = req.username.trim();
    if let Err(detail) = validate_username(username) {
        return Err(error_response(StatusCode::BAD_REQUEST, detail));
    }

    let user_id = format_user_id(username);

    // Rate limit: max 10 attempts per 5-minute window per user_id
    {
        use super::super::helpers::now_secs;
        use super::super::state::TotpAttemptRecord;
        let now = now_secs();
        let window = 300.0; // 5 minutes
        let max_attempts = 10u32;
        let key = format!("login:{}", user_id);

        let mut attempts = state.totp_attempts.write().await;
        let entry = attempts.entry(key).or_insert(TotpAttemptRecord {
            count: 0,
            window_start: now,
        });

        if now - entry.window_start > window {
            entry.count = 0;
            entry.window_start = now;
        }

        if entry.count >= max_attempts {
            return Err(error_response(
                StatusCode::TOO_MANY_REQUESTS,
                "Too many login attempts. Try again in a few minutes.",
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
                .update_one(
                    doc! { "_id": &user_id },
                    doc! { "$set": { "is_admin": true } },
                )
                .await;
            is_admin = true;
        }
    }

    // If TOTP is set up and verified, require a TOTP code or recovery code
    if user.totp_verified && !user.totp_secret.is_empty() {
        match &req.totp_code {
            None => {
                return Ok(
                    (HeaderMap::new(), Json(json!({ "requires_totp": true }))).into_response()
                );
            }
            Some(code) => {
                verify_totp_or_recovery(code, &user, username, &state).await?;
            }
        }
    }

    let device_id = req.device_id.unwrap_or_else(|| generate_id("DEVICE"));
    let access_token = create_access_token(&user_id, &state.jwt_secret);
    let refresh_token = create_refresh_token(&user_id, &state.jwt_secret);

    let ip = extract_ip(&headers, Some(peer));
    let ua = extract_ua(&headers);
    store_refresh_token(&state, &refresh_token, &user_id, &ip, &ua).await;

    Ok((
        auth_cookie_headers(&access_token, &refresh_token),
        Json(json!({
            "user_id": user_id,
            "access_token": access_token,
            "refresh_token": refresh_token,
            "device_id": device_id,
            "is_admin": is_admin,
            "totp_verified": user.totp_verified
        })),
    )
        .into_response())
}

pub(crate) async fn recovery_login(
    State(state): State<Arc<AppState>>,
    Json(req): Json<RecoveryLoginRequest>,
) -> Result<impl IntoResponse, (StatusCode, Json<Value>)> {
    let username = req.username.trim();
    if let Err(detail) = validate_username(username) {
        return Err(error_response(StatusCode::BAD_REQUEST, detail));
    }

    let user_id = format_user_id(username);

    // Rate limit: max 3 attempts per 15-minute window per user_id
    {
        use super::super::helpers::now_secs;
        use super::super::state::TotpAttemptRecord;
        let now = now_secs();
        let window = 900.0; // 15 minutes
        let max_attempts = 3u32;
        let key = format!("recovery_login:{}", user_id);

        let mut attempts = state.totp_attempts.write().await;
        let entry = attempts.entry(key).or_insert(TotpAttemptRecord {
            count: 0,
            window_start: now,
        });

        if now - entry.window_start > window {
            entry.count = 0;
            entry.window_start = now;
        }

        if entry.count >= max_attempts {
            return Err(error_response(
                StatusCode::TOO_MANY_REQUESTS,
                "Too many recovery login attempts. Try again in 15 minutes.",
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
        .ok_or_else(|| error_response(StatusCode::FORBIDDEN, "Invalid credentials"))?;

    if user.disabled {
        return Err(error_response(StatusCode::FORBIDDEN, "Account is disabled"));
    }

    // Verify recovery code
    let code_hash = hash_recovery_code(&req.recovery_code.to_uppercase());
    let pos = user
        .recovery_codes
        .iter()
        .position(|h| h == &code_hash)
        .ok_or_else(|| error_response(StatusCode::FORBIDDEN, "Invalid recovery code"))?;

    // Remove used recovery code from DB
    let mut remaining = user.recovery_codes.clone();
    remaining.remove(pos);
    let bson_codes: Vec<mongodb::bson::Bson> = remaining
        .iter()
        .map(|s| mongodb::bson::Bson::String(s.clone()))
        .collect();
    // Remove used code and flag for forced password reset
    let _ = users
        .update_one(
            doc! { "_id": &user_id },
            doc! { "$set": { "recovery_codes": bson_codes, "must_reset_password": true } },
        )
        .await;

    // Clear rate limit on success
    {
        let key = format!("recovery_login:{}", user_id);
        let mut attempts = state.totp_attempts.write().await;
        attempts.remove(&key);
    }

    let device_id = generate_id("DEVICE");
    let access_token = create_access_token(&user_id, &state.jwt_secret);
    let refresh_token = create_refresh_token(&user_id, &state.jwt_secret);
    store_refresh_token(&state, &refresh_token, &user_id, "Unknown", "Unknown").await;

    Ok((
        auth_cookie_headers(&access_token, &refresh_token),
        Json(json!({
            "user_id": user_id,
            "access_token": access_token,
            "refresh_token": refresh_token,
            "device_id": device_id,
            "is_admin": user.is_admin,
            "totp_verified": user.totp_verified,
            "must_reset_password": true,
            "recovery_codes_remaining": remaining.len()
        })),
    )
        .into_response())
}

/// Reset password after recovery login. Only works when must_reset_password is true.
/// Authenticated via token (no TOTP required).
pub(crate) async fn force_reset_password(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<ForceResetPasswordRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    if req.new_password.len() < 6 {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "Password must be at least 6 characters",
        ));
    }
    if req.new_password.len() > 64 {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "Password must be at most 64 characters",
        ));
    }

    let users = state.db.collection::<UserRecord>("users");
    let user = users
        .find_one(doc! { "_id": &user_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "User not found"))?;

    if !user.must_reset_password {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "Password reset not required",
        ));
    }

    let new_hash = hash_password(&req.new_password);
    let _ = users
        .update_one(
            doc! { "_id": &user_id },
            doc! { "$set": { "password_hash": new_hash, "must_reset_password": false } },
        )
        .await;

    Ok(Json(json!({ "success": true })))
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
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "Password must be at least 6 characters",
        ));
    }
    if req.new_password.len() > 64 {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "Password must be at most 64 characters",
        ));
    }

    let users = state.db.collection::<UserRecord>("users");
    let user = users
        .find_one(doc! { "_id": &user_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "User not found"))?;

    // Verify TOTP or recovery code
    let username = user_id
        .split(':')
        .next()
        .unwrap_or(&user_id)
        .trim_start_matches('@');
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
    let username = user_id
        .split(':')
        .next()
        .unwrap_or(&user_id)
        .trim_start_matches('@');
    verify_totp_or_recovery(&req.totp_code, &user, username, &state).await?;

    // Remove user from all rooms (room_members collection)
    let room_members = state
        .db
        .collection::<mongodb::bson::Document>("room_members");
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
    let _ = refresh_tokens
        .delete_many(doc! { "user_id": &user_id })
        .await;

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
) -> impl IntoResponse {
    if let Some(token) = extract_token(&headers) {
        if let Some(uid) = get_user_from_token(&state, &token) {
            state.active_websockets.write().await.remove(&uid);
            let refresh_tokens = state.db.collection::<RefreshTokenRecord>("refresh_tokens");
            let _ = refresh_tokens.delete_many(doc! { "user_id": &uid }).await;
        }
    }
    // Also revoke the cookie-based refresh token if present
    if let Some(cookie_rt) = extract_refresh_cookie(&headers) {
        let refresh_tokens = state.db.collection::<RefreshTokenRecord>("refresh_tokens");
        let _ = refresh_tokens
            .delete_one(doc! { "token": &cookie_rt })
            .await;
    }

    (clear_cookie_headers(), Json(json!({})))
}

pub(crate) async fn refresh(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<RefreshTokenRequest>,
) -> Result<impl IntoResponse, (StatusCode, Json<Value>)> {
    // Accept refresh token from JSON body (backward compat) or HttpOnly cookie
    let token_str = req
        .refresh_token
        .or_else(|| extract_refresh_cookie(&headers))
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "No refresh token provided"))?;

    // Decode the refresh token JWT
    let claims = decode_token(&token_str, &state.jwt_secret).ok_or_else(|| {
        error_response(StatusCode::UNAUTHORIZED, "Invalid or expired refresh token")
    })?;

    let user_id = claims.sub;

    // Check if refresh token exists in MongoDB (not revoked)
    let refresh_tokens = state.db.collection::<RefreshTokenRecord>("refresh_tokens");
    let found = refresh_tokens
        .find_one_and_delete(doc! { "token": &token_str })
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

    // Issue new token pair, preserving the IP/UA from the consumed token.
    // If the old token has no IP (pre-feature record), capture it from the current request.
    let ip = found
        .as_ref()
        .map(|r| r.ip_address.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| extract_ip(&headers, Some(peer)));
    let ua = found
        .as_ref()
        .map(|r| r.user_agent.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| extract_ua(&headers));
    let new_access = create_access_token(&user_id, &state.jwt_secret);
    let new_refresh = create_refresh_token(&user_id, &state.jwt_secret);
    store_refresh_token(&state, &new_refresh, &user_id, &ip, &ua).await;

    Ok((
        auth_cookie_headers(&new_access, &new_refresh),
        Json(json!({
            "access_token": new_access,
            "refresh_token": new_refresh,
            "is_admin": is_admin,
            "totp_verified": totp_verified
        })),
    )
        .into_response())
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
    let username = user_id
        .split(':')
        .next()
        .unwrap_or(&user_id)
        .trim_start_matches('@');
    let totp = build_totp(&user.totp_secret, username)
        .map_err(|e| error_response(StatusCode::INTERNAL_SERVER_ERROR, &e))?;
    if !totp.check_current(&req.totp_code).unwrap_or(false) {
        return Err(error_response(StatusCode::FORBIDDEN, "Invalid TOTP code"));
    }

    // Generate new recovery codes (replaces old ones)
    let (plaintext_codes, hashed_codes) = generate_recovery_codes(5);
    let bson_codes: Vec<mongodb::bson::Bson> = hashed_codes
        .iter()
        .map(|s| mongodb::bson::Bson::String(s.clone()))
        .collect();
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
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "2FA is already set up",
        ));
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

    let username = user_id
        .split(':')
        .next()
        .unwrap_or(&user_id)
        .trim_start_matches('@');
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
        "totp_verified": user.totp_verified,
        // The caller's own entrance sting. It is not in presence, because only
        // its owner needs to see it — everyone else is sent the URL with the
        // voice join that plays it.
        "entrance_sound_url": user.entrance_sound_url
    })))
}

async fn store_refresh_token(
    state: &AppState,
    token: &str,
    user_id: &str,
    ip_address: &str,
    user_agent: &str,
) {
    use rand::Rng;
    let session_id = hex::encode(rand::thread_rng().gen::<[u8; 16]>());
    let collection = state.db.collection::<RefreshTokenRecord>("refresh_tokens");
    let record = RefreshTokenRecord {
        token: token.to_string(),
        user_id: user_id.to_string(),
        expires_at: chrono::Utc::now() + chrono::Duration::days(7),
        ip_address: ip_address.to_string(),
        user_agent: user_agent.to_string(),
        created_at: chrono::Utc::now().timestamp_millis(),
        session_id,
    };
    let _ = collection.insert_one(record).await;
}

/// Extract the best available client IP from request headers, falling back to the peer address.
fn extract_ip(headers: &HeaderMap, peer: Option<SocketAddr>) -> String {
    headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.split(',').next())
        .map(|s| s.trim().to_string())
        .or_else(|| {
            headers
                .get("x-real-ip")
                .and_then(|v| v.to_str().ok())
                .map(str::to_string)
        })
        .or_else(|| peer.map(|a| a.ip().to_string()))
        .unwrap_or_else(|| "Unknown".to_string())
}

/// Extract User-Agent from request headers.
fn extract_ua(headers: &HeaderMap) -> String {
    headers
        .get("user-agent")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("Unknown")
        .to_string()
}

pub(crate) async fn list_sessions(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    use futures_util::TryStreamExt;
    let collection = state.db.collection::<RefreshTokenRecord>("refresh_tokens");
    let mut cursor = collection
        .find(doc! { "user_id": &user_id })
        .await
        .map_err(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "DB error"))?;

    let mut sessions = Vec::new();
    while let Ok(Some(record)) = cursor.try_next().await {
        sessions.push(json!({
            "session_id": record.session_id,
            "ip_address": record.ip_address,
            "user_agent": record.user_agent,
            "created_at": record.created_at,
        }));
    }

    Ok(Json(json!({ "sessions": sessions })))
}

/// DELETE /api/account/sessions/:session_id
/// Revokes a specific session belonging to the authenticated user.
pub(crate) async fn revoke_session(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    axum::extract::Path(session_id): axum::extract::Path<String>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let collection = state.db.collection::<RefreshTokenRecord>("refresh_tokens");
    let result = collection
        .delete_one(doc! { "session_id": &session_id, "user_id": &user_id })
        .await
        .map_err(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "DB error"))?;

    if result.deleted_count == 0 {
        return Err(error_response(StatusCode::NOT_FOUND, "Session not found"));
    }

    Ok(Json(json!({ "success": true })))
}
