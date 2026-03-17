use super::super::state::{AppState, InviteRecord, RoomRecord};
use axum::{
    extract::{Path, State},
    http::HeaderMap,
    response::{Html, Json},
};
use mongodb::bson::doc;
use serde_json::{json, Value};
use std::sync::Arc;

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

pub(crate) async fn serve_client() -> Html<String> {
    let html = std::fs::read_to_string("client/dist/index.html")
        .unwrap_or_else(|_| "<h1>No client found.</h1>".to_string());
    Html(html)
}

pub(crate) async fn serve_invite_page(
    State(state): State<Arc<AppState>>,
    Path(code): Path<String>,
    headers: HeaderMap,
) -> Html<String> {
    let html = std::fs::read_to_string("client/dist/index.html")
        .unwrap_or_else(|_| "<h1>No client found.</h1>".to_string());

    // Build base URL from request headers so relative icon_url paths become absolute
    let base_url = {
        let host = headers
            .get("host")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("localhost");
        let is_local = host.starts_with("localhost") || host.starts_with("127.");
        let scheme = if is_local { "http" } else { "https" };
        format!("{}://{}", scheme, host)
    };

    let room_info = async {
        let inv_coll = state.db.collection::<InviteRecord>("invites");
        let invite = inv_coll
            .find_one(doc! { "_id": &code })
            .await
            .ok()
            .flatten()?;
        let rooms_coll = state.db.collection::<RoomRecord>("rooms");
        let room = rooms_coll
            .find_one(doc! { "_id": &invite.room_id })
            .await
            .ok()
            .flatten()?;
        Some((room.name, room.icon_url))
    }
    .await;

    let final_html = if let Some((room_name, icon_url)) = room_info {
        let escaped_name = html_escape(&room_name);
        let title = format!("Join {} on Chatter", escaped_name);
        let description = format!("You've been invited to join {}", escaped_name);
        let page_url = html_escape(&format!("{}/invite/{}", base_url, code));

        let image_tags = if !icon_url.is_empty() {
            // Make relative paths absolute so crawlers (Discord, etc.) can fetch the image
            let abs_url = if icon_url.starts_with('/') {
                format!("{}{}", base_url, icon_url)
            } else {
                icon_url.clone()
            };
            let escaped_url = html_escape(&abs_url);
            format!(
                "    <meta property=\"og:image\" content=\"{}\" />\n    <meta name=\"twitter:image\" content=\"{}\" />\n    <meta name=\"twitter:card\" content=\"summary\" />\n",
                escaped_url, escaped_url
            )
        } else {
            "    <meta name=\"twitter:card\" content=\"summary\" />\n".to_string()
        };

        let og = format!(
            "    <meta property=\"og:title\" content=\"{}\" />\n    <meta property=\"og:description\" content=\"{}\" />\n    <meta property=\"og:type\" content=\"website\" />\n    <meta property=\"og:url\" content=\"{}\" />\n    <meta name=\"twitter:title\" content=\"{}\" />\n    <meta name=\"twitter:description\" content=\"{}\" />\n{}",
            title, description, page_url, title, description, image_tags
        );

        html.replace("</head>", &format!("{}</head>", og))
    } else {
        html
    };

    Html(final_html)
}

pub(crate) async fn versions() -> Json<Value> {
    Json(json!({
        "versions": ["r0.5.0", "r0.6.0", "r0.6.1"]
    }))
}

pub(crate) async fn build_version() -> Json<Value> {
    Json(json!({ "version": env!("BUILD_TIMESTAMP") }))
}
