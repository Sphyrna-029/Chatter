use axum::response::{Html, Json};
use serde_json::{json, Value};

pub(crate) async fn serve_client() -> Html<String> {
    let html = std::fs::read_to_string("client/dist/index.html")
        .unwrap_or_else(|_| "<h1>No client found.</h1>".to_string());
    Html(html)
}

pub(crate) async fn versions() -> Json<Value> {
    Json(json!({
        "versions": ["r0.5.0", "r0.6.0", "r0.6.1"]
    }))
}
