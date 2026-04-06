use super::super::{
    helpers::{auth_cookie_headers, create_access_token, create_refresh_token, decode_token, error_response, extract_token, get_user_from_token, now_secs},
    state::{AppState, RefreshTokenRecord, SteamLoginCode, UserRecord},
};
use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Json, Redirect},
};
use mongodb::bson::doc;
use rand::Rng;
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Arc};

fn get_base_url(headers: &HeaderMap) -> String {
    std::env::var("SERVER_URL").unwrap_or_else(|_| {
        let host = headers
            .get("host")
            .and_then(|h| h.to_str().ok())
            .unwrap_or("localhost:8000");
        let proto = headers
            .get("x-forwarded-proto")
            .and_then(|h| h.to_str().ok())
            .unwrap_or("http");
        format!("{}://{}", proto, host)
    })
}

fn build_steam_openid_url(return_to: &str, realm: &str) -> String {
    let params = [
        ("openid.ns", "http://specs.openid.net/auth/2.0"),
        ("openid.mode", "checkid_setup"),
        ("openid.return_to", return_to),
        ("openid.realm", realm),
        ("openid.identity", "http://specs.openid.net/auth/2.0/identifier_select"),
        ("openid.claimed_id", "http://specs.openid.net/auth/2.0/identifier_select"),
    ];
    let query: String = params
        .iter()
        .map(|(k, v)| format!("{}={}", k, urlencoding::encode(v)))
        .collect::<Vec<_>>()
        .join("&");
    format!("https://steamcommunity.com/openid/login?{}", query)
}

/// Verify OpenID response with Steam's check_authentication endpoint.
/// Returns the Steam64 ID on success.
async fn verify_steam_openid(params: &HashMap<String, String>) -> Result<String, ()> {
    let mut verify_params: Vec<(String, String)> = params
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();

    // Replace openid.mode with check_authentication
    for (k, v) in verify_params.iter_mut() {
        if k == "openid.mode" {
            *v = "check_authentication".to_string();
        }
    }

    let client = reqwest::Client::new();
    let resp = client
        .post("https://steamcommunity.com/openid/login")
        .form(&verify_params)
        .send()
        .await
        .map_err(|_| ())?;

    let body = resp.text().await.map_err(|_| ())?;
    if !body.contains("is_valid:true") {
        return Err(());
    }

    // Extract Steam64 ID from claimed_id URL
    let claimed_id = params.get("openid.claimed_id").ok_or(())?;
    let steam64 = claimed_id.split('/').last().ok_or(())?.to_string();
    steam64.parse::<u64>().map_err(|_| ())?;
    Ok(steam64)
}

async fn store_refresh_token(state: &AppState, token: &str, user_id: &str) {
    let collection = state.db.collection::<RefreshTokenRecord>("refresh_tokens");
    let record = RefreshTokenRecord {
        token: token.to_string(),
        user_id: user_id.to_string(),
        expires_at: chrono::Utc::now() + chrono::Duration::days(7),
    };
    let _ = collection.insert_one(record).await;
}

/// GET /api/auth/steam/login
/// Redirects the browser to Steam's OpenID login page.
/// Requires SERVER_URL env var set to the public server URL.
pub(crate) async fn steam_login(
    State(_state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let base_url = get_base_url(&headers);
    let return_to = format!("{}/api/auth/steam/callback?mode=login", base_url);
    let steam_url = build_steam_openid_url(&return_to, &base_url);
    Redirect::temporary(&steam_url)
}

/// GET /api/steam/link-url (auth required)
/// Returns a Steam OpenID URL the client should navigate to in order to link
/// their Steam account to their existing Chatter account.
pub(crate) async fn steam_link_url(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    if state.steam_api_key.is_empty() {
        return Err(error_response(StatusCode::SERVICE_UNAVAILABLE, "Steam integration not configured"));
    }

    // Use a 15-minute JWT as the state token to carry the user_id through the redirect
    let state_token = create_access_token(&user_id, &state.jwt_secret);
    let base_url = get_base_url(&headers);
    let return_to = format!(
        "{}/api/auth/steam/callback?mode=link&state={}",
        base_url,
        urlencoding::encode(&state_token)
    );
    let steam_url = build_steam_openid_url(&return_to, &base_url);
    Ok(Json(json!({ "url": steam_url })))
}

/// GET /api/auth/steam/callback
/// Handles the OpenID redirect from Steam. Depending on `mode` query param:
///   - "login": find user by steam_id, issue tokens, redirect to SPA with tokens in URL
///   - "link": verify state JWT, attach steam_id to existing user, redirect to SPA
pub(crate) async fn steam_callback(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let base_url = get_base_url(&headers);
    let mode = params.get("mode").cloned().unwrap_or_default();

    let steam64_id = match verify_steam_openid(&params).await {
        Ok(id) => id,
        Err(_) => {
            return Redirect::temporary(&format!("{}/?steam_error=verification_failed", base_url))
                .into_response()
        }
    };

    let users = state.db.collection::<UserRecord>("users");

    match mode.as_str() {
        "link" => {
            let state_token = params.get("state").cloned().unwrap_or_default();
            let user_id = match decode_token(&state_token, &state.jwt_secret) {
                Some(claims) => claims.sub,
                None => {
                    return Redirect::temporary(&format!("{}/?steam_error=invalid_state", base_url))
                        .into_response()
                }
            };

            // Ensure no other account already has this Steam ID
            if users
                .find_one(doc! { "steam_id": &steam64_id })
                .await
                .ok()
                .flatten()
                .is_some()
            {
                return Redirect::temporary(&format!("{}/?steam_error=already_linked", base_url))
                    .into_response();
            }

            let _ = users
                .update_one(
                    doc! { "_id": &user_id },
                    doc! { "$set": { "steam_id": &steam64_id } },
                )
                .await;

            Redirect::temporary(&format!("{}/?steam_linked=true", base_url)).into_response()
        }

        "login" => {
            let user = match users
                .find_one(doc! { "steam_id": &steam64_id })
                .await
                .ok()
                .flatten()
            {
                Some(u) => u,
                None => {
                    return Redirect::temporary(&format!("{}/?steam_error=no_account", base_url))
                        .into_response()
                }
            };

            if user.disabled {
                return Redirect::temporary(&format!(
                    "{}/?steam_error=account_disabled",
                    base_url
                ))
                .into_response();
            }

            let user_id = &user.user_id;
            let access_token = create_access_token(user_id, &state.jwt_secret);
            let refresh_token = create_refresh_token(user_id, &state.jwt_secret);
            store_refresh_token(&state, &refresh_token, user_id).await;

            // Issue a short-lived one-time code instead of putting tokens in the URL.
            // The client exchanges this code via POST /api/auth/steam/exchange.
            let code = hex::encode(rand::thread_rng().gen::<[u8; 32]>());
            {
                let mut codes = state.steam_login_codes.write().await;
                codes.insert(code.clone(), SteamLoginCode {
                    access_token,
                    refresh_token,
                    user_id: user_id.clone(),
                    is_admin: user.is_admin,
                    totp_verified: user.totp_verified,
                    expires_at: now_secs() + 60.0,
                });
            }

            Redirect::temporary(&format!("{}/?steam_code={}", base_url, code)).into_response()
        }

        _ => {
            Redirect::temporary(&format!("{}/?steam_error=invalid_mode", base_url)).into_response()
        }
    }
}

/// POST /api/auth/steam/exchange
/// Exchanges a one-time `steam_code` (from the OAuth callback redirect) for session tokens.
/// The code is consumed on first use and expires after 60 seconds.
pub(crate) async fn steam_exchange(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> Result<impl IntoResponse, (StatusCode, Json<Value>)> {
    let code = body
        .get("code")
        .and_then(|v| v.as_str())
        .ok_or_else(|| error_response(StatusCode::BAD_REQUEST, "Missing code"))?;

    // Remove atomically — prevents replay even under concurrent requests.
    let record = state.steam_login_codes.write().await.remove(code);
    let record = record.ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Invalid or expired code"))?;

    if now_secs() > record.expires_at {
        return Err(error_response(StatusCode::GONE, "Code has expired"));
    }

    Ok((
        auth_cookie_headers(&record.access_token, &record.refresh_token),
        Json(json!({
            "access_token":  record.access_token,
            "refresh_token": record.refresh_token,
            "user_id":       record.user_id,
            "is_admin":      record.is_admin,
            "totp_verified": record.totp_verified,
        })),
    ))
}

/// GET /api/steam/status (auth required)
/// Returns the current user's linked Steam ID (null if not linked) and hide_game flag.
pub(crate) async fn steam_status(
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

    Ok(Json(json!({ "steam_id": user.steam_id, "hide_game": user.hide_steam_game })))
}

/// PUT /api/steam/hide-game (auth required)
/// Toggles whether the user's currently playing game is shown to others.
pub(crate) async fn steam_set_hide_game(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let hide = body.get("hide").and_then(|v| v.as_bool()).unwrap_or(false);

    let users = state.db.collection::<UserRecord>("users");
    let _ = users
        .update_one(
            doc! { "_id": &user_id },
            doc! { "$set": { "hide_steam_game": hide } },
        )
        .await;

    // If hiding, clear the game from ephemeral presence immediately
    if hide {
        let mut up = state.user_presence.write().await;
        if let Some(p) = up.get_mut(&user_id) {
            p.steam_game = None;
        }
    }

    Ok(Json(json!({ "success": true, "hide_game": hide })))
}

/// DELETE /api/steam/unlink (auth required)
/// Removes the Steam ID from the current user's account.
pub(crate) async fn steam_unlink(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let users = state.db.collection::<UserRecord>("users");
    let _ = users
        .update_one(
            doc! { "_id": &user_id },
            doc! { "$unset": { "steam_id": "" } },
        )
        .await;

    // Clear game from ephemeral presence
    {
        let mut up = state.user_presence.write().await;
        if let Some(p) = up.get_mut(&user_id) {
            p.steam_game = None;
        }
    }

    Ok(Json(json!({ "success": true })))
}
