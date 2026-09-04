use super::super::{
    helpers::{
        create_access_token, decode_token, error_response, extract_token, get_user_from_token,
    },
    state::{AppState, UserRecord},
};
use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Json, Redirect},
};
use mongodb::bson::doc;
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

/// GET /api/spotify/link-url (auth required)
/// Returns a Spotify OAuth URL the client should navigate to in order to link their account.
pub(crate) async fn spotify_link_url(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    if state.spotify_client_id.is_empty() {
        return Err(error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "Spotify integration not configured",
        ));
    }

    let state_token = create_access_token(&user_id, &state.jwt_secret);
    let base_url = get_base_url(&headers);
    let redirect_uri = format!("{}/api/auth/spotify/callback", base_url);

    let params = [
        ("client_id", state.spotify_client_id.as_str()),
        ("response_type", "code"),
        ("redirect_uri", redirect_uri.as_str()),
        (
            "scope",
            "user-read-currently-playing user-read-playback-state",
        ),
        ("state", state_token.as_str()),
    ];
    let query: String = params
        .iter()
        .map(|(k, v)| format!("{}={}", k, urlencoding::encode(v)))
        .collect::<Vec<_>>()
        .join("&");
    let url = format!("https://accounts.spotify.com/authorize?{}", query);

    Ok(Json(json!({ "url": url })))
}

/// GET /api/auth/spotify/callback
/// Handles the OAuth redirect from Spotify. Exchanges authorization code for tokens
/// and stores the refresh token on the user's account.
pub(crate) async fn spotify_callback(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let base_url = get_base_url(&headers);

    if let Some(err) = params.get("error") {
        return Redirect::temporary(&format!(
            "{}/?spotify_error={}",
            base_url,
            urlencoding::encode(err)
        ))
        .into_response();
    }

    let code = match params.get("code") {
        Some(c) => c.clone(),
        None => {
            return Redirect::temporary(&format!("{}/?spotify_error=missing_code", base_url))
                .into_response()
        }
    };

    let state_token = match params.get("state") {
        Some(s) => s.clone(),
        None => {
            return Redirect::temporary(&format!("{}/?spotify_error=missing_state", base_url))
                .into_response()
        }
    };

    let user_id = match decode_token(&state_token, &state.jwt_secret) {
        Some(claims) => claims.sub,
        None => {
            return Redirect::temporary(&format!("{}/?spotify_error=invalid_state", base_url))
                .into_response()
        }
    };

    let redirect_uri = format!("{}/api/auth/spotify/callback", base_url);
    let client = reqwest::Client::new();
    let token_params = [
        ("grant_type", "authorization_code"),
        ("code", code.as_str()),
        ("redirect_uri", redirect_uri.as_str()),
    ];
    let resp = match client
        .post("https://accounts.spotify.com/api/token")
        .basic_auth(&state.spotify_client_id, Some(&state.spotify_client_secret))
        .form(&token_params)
        .send()
        .await
    {
        Ok(r) => r,
        Err(_) => {
            return Redirect::temporary(&format!(
                "{}/?spotify_error=token_exchange_failed",
                base_url
            ))
            .into_response()
        }
    };

    let body: Value = match resp.json().await {
        Ok(b) => b,
        Err(_) => {
            return Redirect::temporary(&format!("{}/?spotify_error=token_parse_failed", base_url))
                .into_response()
        }
    };

    let refresh_token = match body["refresh_token"].as_str() {
        Some(rt) => rt.to_string(),
        None => {
            return Redirect::temporary(&format!("{}/?spotify_error=no_refresh_token", base_url))
                .into_response()
        }
    };

    let users = state.db.collection::<UserRecord>("users");
    let _ = users
        .update_one(
            doc! { "_id": &user_id },
            doc! { "$set": { "spotify_refresh_token": &refresh_token } },
        )
        .await;

    Redirect::temporary(&format!("{}/?spotify_linked=true", base_url)).into_response()
}

/// GET /api/spotify/status (auth required)
/// Returns whether the user has a linked Spotify account and their hide preference.
pub(crate) async fn spotify_status(
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
        "linked": user.spotify_refresh_token.is_some(),
        "hide": user.hide_spotify
    })))
}

/// PUT /api/spotify/hide (auth required)
/// Toggles whether the user's currently playing track is shown to others.
pub(crate) async fn spotify_set_hide(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
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
            doc! { "$set": { "hide_spotify": hide } },
        )
        .await;

    if hide {
        let mut up = state.user_presence.write().await;
        if let Some(p) = up.get_mut(&user_id) {
            p.spotify_track = None;
            p.spotify_artist = None;
            p.spotify_album_art = None;
        }
    }

    Ok(Json(json!({ "success": true, "hide": hide })))
}

/// DELETE /api/spotify/unlink (auth required)
/// Removes the Spotify refresh token from the current user's account.
pub(crate) async fn spotify_unlink(
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
            doc! { "$unset": { "spotify_refresh_token": "" } },
        )
        .await;

    // Clear from token cache
    {
        let mut tokens = state.spotify_tokens.write().await;
        tokens.remove(&user_id);
    }

    // Clear from ephemeral presence
    {
        let mut up = state.user_presence.write().await;
        if let Some(p) = up.get_mut(&user_id) {
            p.spotify_track = None;
            p.spotify_artist = None;
            p.spotify_album_art = None;
        }
    }

    Ok(Json(json!({ "success": true })))
}
