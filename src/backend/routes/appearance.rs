//! The caller's own appearance settings, so a theme follows them to a new
//! device instead of being rebuilt there.
//!
//! This is one document per user and nobody but the owner ever reads it. It is
//! stored, not interpreted: the server does not derive colours or decide what
//! a theme looks like — that stays in the client, in one place — it only
//! checks that what it is handed is small, well-formed, and safe to hand back.
//!
//! "Safe to hand back" is the reason for the validation below rather than a
//! blob column. A theme id is interpolated into a CSS attribute selector by
//! the client, and colours are written into custom properties, so both are
//! constrained here as well as there. A value that only round-trips to its own
//! author is still a value this server chose to store.

use super::super::{
    helpers::{error_response, extract_token, get_user_from_token, now_millis, rate_limited},
    ratelimit,
    state::AppState,
};
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::Json,
};
use mongodb::bson::{doc, Bson, Document};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

/// Enough for anyone building a palette, few enough that the document stays
/// small and one account cannot grow without bound.
const MAX_CUSTOM_THEMES: usize = 50;
const MAX_NAME_LEN: usize = 60;
const MAX_ID_LEN: usize = 64;

/// Saving is a background write on every slider drag, so the burst has to
/// cover a settings session; the sustained rate does not.
const SAVE_APPEARANCE: ratelimit::Quota = ratelimit::Quota {
    capacity: 40.0,
    refill_per_sec: 0.5,
};

/// Theme ids reach a CSS selector, so they are restricted to what cannot end a
/// quoted string or open anything: the shape the client generates and no more.
fn valid_theme_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ID_LEN
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn valid_hex(value: &str) -> bool {
    value.len() == 7 && value.starts_with('#') && value[1..].chars().all(|c| c.is_ascii_hexdigit())
}

#[derive(Deserialize)]
pub(crate) struct ThemeColorsPayload {
    pub(crate) background: String,
    pub(crate) card: String,
    pub(crate) accent: String,
    pub(crate) primary: String,
}

#[derive(Deserialize)]
pub(crate) struct CustomThemePayload {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) mode: String,
    pub(crate) colors: ThemeColorsPayload,
}

#[derive(Deserialize)]
pub(crate) struct DisplayPayload {
    pub(crate) font_scale: f64,
    pub(crate) radius: f64,
    pub(crate) density: String,
    pub(crate) motion: String,
}

#[derive(Deserialize)]
pub(crate) struct SetAppearanceRequest {
    pub(crate) theme_id: String,
    pub(crate) custom_themes: Vec<CustomThemePayload>,
    pub(crate) display: DisplayPayload,
}

/// Everything the client needs to look right on a device that has never seen
/// this account, in one request. Absent settings answer with nulls rather than
/// a 404: "this account has never saved any" is not an error.
pub(crate) async fn get_appearance(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let found = state
        .db
        .collection::<Document>("appearance_settings")
        .find_one(doc! { "_id": &user_id })
        .await
        .ok()
        .flatten();

    let Some(doc) = found else {
        return Ok(Json(json!({
            "theme_id": Value::Null,
            "custom_themes": Value::Null,
            "display": Value::Null,
            "updated_at": 0,
        })));
    };

    Ok(Json(json!({
        "theme_id": doc.get_str("theme_id").ok(),
        "custom_themes": doc.get_array("custom_themes").ok().map(|a| {
            a.iter().filter_map(bson_to_json).collect::<Vec<Value>>()
        }),
        "display": doc.get_document("display").ok().and_then(|d| {
            bson_to_json(&Bson::Document(d.clone()))
        }),
        "updated_at": doc.get_i64("updated_at").unwrap_or(0),
    })))
}

fn bson_to_json(value: &Bson) -> Option<Value> {
    serde_json::to_value(value.clone().into_relaxed_extjson()).ok()
}

/// Replace the caller's settings.
///
/// A whole-document replace rather than a merge: the client holds the complete
/// set and sends it, and a merge would make deleting a custom theme
/// impossible to express.
pub(crate) async fn set_appearance(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<SetAppearanceRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    if let Err(retry_after) =
        ratelimit::check(&state, &format!("appearance:{user_id}"), SAVE_APPEARANCE).await
    {
        return Err(rate_limited(retry_after, "Too many appearance changes"));
    }

    // "system" is the one selection that is not a theme id.
    if req.theme_id != "system" && !valid_theme_id(&req.theme_id) {
        return Err(error_response(StatusCode::BAD_REQUEST, "Invalid theme id"));
    }
    if req.custom_themes.len() > MAX_CUSTOM_THEMES {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "Too many custom themes",
        ));
    }

    let mut themes: Vec<Document> = Vec::with_capacity(req.custom_themes.len());
    for theme in &req.custom_themes {
        if !valid_theme_id(&theme.id) {
            return Err(error_response(StatusCode::BAD_REQUEST, "Invalid theme id"));
        }
        if theme.name.trim().is_empty() || theme.name.chars().count() > MAX_NAME_LEN {
            return Err(error_response(
                StatusCode::BAD_REQUEST,
                "Invalid theme name",
            ));
        }
        if theme.mode != "light" && theme.mode != "dark" {
            return Err(error_response(
                StatusCode::BAD_REQUEST,
                "Invalid theme mode",
            ));
        }
        let c = &theme.colors;
        if ![&c.background, &c.card, &c.accent, &c.primary]
            .iter()
            .all(|v| valid_hex(v))
        {
            return Err(error_response(
                StatusCode::BAD_REQUEST,
                "Theme colours must be #rrggbb",
            ));
        }
        themes.push(doc! {
            "id": &theme.id,
            "name": theme.name.trim(),
            "mode": &theme.mode,
            "colors": {
                "background": c.background.to_ascii_lowercase(),
                "card": c.card.to_ascii_lowercase(),
                "accent": c.accent.to_ascii_lowercase(),
                "primary": c.primary.to_ascii_lowercase(),
            },
        });
    }

    let d = &req.display;
    if !d.font_scale.is_finite() || !(0.5..=2.0).contains(&d.font_scale) {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "Invalid font scale",
        ));
    }
    if !d.radius.is_finite() || !(0.0..=3.0).contains(&d.radius) {
        return Err(error_response(StatusCode::BAD_REQUEST, "Invalid radius"));
    }
    if d.density != "comfortable" && d.density != "compact" {
        return Err(error_response(StatusCode::BAD_REQUEST, "Invalid density"));
    }
    if !["system", "reduce", "full"].contains(&d.motion.as_str()) {
        return Err(error_response(StatusCode::BAD_REQUEST, "Invalid motion"));
    }

    let updated_at = now_millis();
    let _ = state
        .db
        .collection::<Document>("appearance_settings")
        .update_one(
            doc! { "_id": &user_id },
            doc! { "$set": {
                "theme_id": &req.theme_id,
                "custom_themes": &themes,
                "display": {
                    "font_scale": d.font_scale,
                    "radius": d.radius,
                    "density": &d.density,
                    "motion": &d.motion,
                },
                "updated_at": updated_at,
            }},
        )
        .upsert(true)
        .await;

    Ok(Json(json!({ "saved": true, "updated_at": updated_at })))
}
