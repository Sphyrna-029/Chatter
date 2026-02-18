use super::super::{
    constants::MAX_UPLOAD_SIZE,
    dto::LinkPreviewQuery,
    helpers::{error_response, extract_token, get_user_from_token},
    state::{AppState, CachedPreview},
};
use axum::{
    extract::{Multipart, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Json},
};
use serde_json::json;
use std::sync::Arc;

pub(crate) async fn upload_file(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> impl IntoResponse {
    let token = match extract_token(&headers) {
        Some(t) => t,
        None => return error_response(StatusCode::UNAUTHORIZED, "Missing token"),
    };
    if get_user_from_token(&state, &token).await.is_none() {
        return error_response(StatusCode::UNAUTHORIZED, "Invalid token");
    }

    let mut filename = String::new();
    let mut data = None;

    while let Ok(Some(field)) = multipart.next_field().await {
        let name = field.name().unwrap_or("").to_string();
        if name == "filename" {
            if let Ok(text) = field.text().await {
                filename = text;
            }
        } else if name == "file" {
            if filename.is_empty() {
                filename = field.file_name().unwrap_or("upload").to_string();
            }
            match field.bytes().await {
                Ok(b) => data = Some(b),
                Err(_) => return error_response(StatusCode::BAD_REQUEST, "Failed to read file"),
            }
        }
    }

    let data = match data {
        Some(d) => d,
        None => return error_response(StatusCode::BAD_REQUEST, "No file field"),
    };

    let filename = filename.replace(['/', '\\', '\0'], "_");
    if filename.is_empty() {
        return error_response(StatusCode::BAD_REQUEST, "No filename provided");
    }

    if data.len() > MAX_UPLOAD_SIZE {
        return error_response(StatusCode::BAD_REQUEST, "File too large (max 500MB)");
    }

    // Generate random folder name
    use rand::Rng;
    let bytes: [u8; 16] = rand::thread_rng().gen();
    let folder: String = bytes.iter().map(|b| format!("{:02x}", b)).collect();

    let dir = format!("external/{}", folder);
    if tokio::fs::create_dir_all(&dir).await.is_err() {
        return error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to create directory",
        );
    }

    let path = format!("{}/{}", dir, filename);
    if tokio::fs::write(&path, &data).await.is_err() {
        return error_response(StatusCode::INTERNAL_SERVER_ERROR, "Failed to write file");
    }

    use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
    // Encode characters that break URLs: spaces, quotes, angle brackets, etc.
    const ENCODE_SET: &AsciiSet = &CONTROLS
        .add(b' ')
        .add(b'"')
        .add(b'<')
        .add(b'>')
        .add(b'`')
        .add(b'#')
        .add(b'?')
        .add(b'{')
        .add(b'}');
    let encoded_filename = utf8_percent_encode(&filename, ENCODE_SET).to_string();

    // Build the URL from the incoming Host header so that it works in both
    // local development (http://localhost:8000) and production deployments.
    let host = headers
        .get("host")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("localhost:8000");
    let scheme = if host.starts_with("localhost") || host.starts_with("127.0.0.1") {
        "http"
    } else {
        "https"
    };
    let url = format!("{scheme}://{host}/external/{folder}/{encoded_filename}");
    (StatusCode::OK, Json(json!({ "url": url })))
}

// ---------------------------------------------------------------------------
// Link preview
// ---------------------------------------------------------------------------

pub(crate) fn extract_og_tag(html: &str, property: &str) -> Option<String> {
    // Look for <meta property="og:___" content="...">
    let pattern = format!("property=\"{}\"", property);
    let pos = html.find(&pattern)?;
    let snippet = &html[pos..];
    // Find content attribute
    let content_start = snippet.find("content=\"")? + 9;
    let content_end = snippet[content_start..].find('"')? + content_start;
    let value = snippet[content_start..content_end].to_string();
    if value.is_empty() {
        return None;
    }
    Some(value)
}

pub(crate) fn extract_title_tag(html: &str) -> Option<String> {
    let start = html.find("<title")?.checked_add(6)?;
    let rest = &html[start..];
    let after_open = rest.find('>')? + 1;
    let end = rest[after_open..].find("</title>")?;
    let title = rest[after_open..after_open + end].trim().to_string();
    if title.is_empty() {
        return None;
    }
    Some(title)
}

pub(crate) async fn link_preview(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<LinkPreviewQuery>,
) -> impl IntoResponse {
    let token = match extract_token(&headers) {
        Some(t) => t,
        None => return error_response(StatusCode::UNAUTHORIZED, "Missing token"),
    };
    if get_user_from_token(&state, &token).await.is_none() {
        return error_response(StatusCode::UNAUTHORIZED, "Invalid token");
    }

    let url = query.url.clone();

    // Check cache
    {
        let cache = state.link_previews.read().await;
        if let Some(cached) = cache.get(&url) {
            return (StatusCode::OK, Json(serde_json::to_value(cached).unwrap()));
        }
    }

    // Fetch the URL
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    let browser_ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

    // Twitter/X: use oEmbed API since their pages are client-rendered
    let is_twitter = url.contains("twitter.com/") || url.contains("x.com/");
    let preview = if is_twitter {
        let oembed_url = format!(
            "https://publish.twitter.com/oembed?url={}&omit_script=true",
            urlencoding::encode(&url)
        );
        match client
            .get(&oembed_url)
            .header("User-Agent", browser_ua)
            .header("Accept", "application/json")
            .send()
            .await
        {
            Ok(resp) => {
                if let Ok(json) = resp.json::<serde_json::Value>().await {
                    CachedPreview {
                        title: json["author_name"].as_str().map(|a| format!("@{}", a)),
                        description: json["html"]
                            .as_str()
                            .map(|h| {
                                // Strip HTML tags to get plain tweet text
                                let stripped = h
                                    .replace("<br>", "\n")
                                    .replace("&amp;", "&")
                                    .replace("&lt;", "<")
                                    .replace("&gt;", ">");
                                let tag_re = regex::Regex::new(r"<[^>]+>").unwrap();
                                let text = tag_re.replace_all(&stripped, "").to_string();
                                if text.len() > 280 {
                                    format!("{}...", &text[..277])
                                } else {
                                    text
                                }
                            }),
                        image: None,
                        site_name: Some("Twitter".to_string()),
                    }
                } else {
                    CachedPreview {
                        title: None,
                        description: None,
                        image: None,
                        site_name: None,
                    }
                }
            }
            Err(_) => return error_response(StatusCode::BAD_GATEWAY, "Failed to fetch URL"),
        }
    } else {
        let response = match client
            .get(&url)
            .header("User-Agent", browser_ua)
            .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
            .send()
            .await
        {
            Ok(r) => r,
            Err(_) => return error_response(StatusCode::BAD_GATEWAY, "Failed to fetch URL"),
        };

        // Limit body to 256KB
        let body = match response.bytes().await {
            Ok(b) if b.len() <= 256 * 1024 => String::from_utf8_lossy(&b).to_string(),
            Ok(b) => String::from_utf8_lossy(&b[..256 * 1024]).to_string(),
            Err(_) => return error_response(StatusCode::BAD_GATEWAY, "Failed to read response"),
        };

        let og_title = extract_og_tag(&body, "og:title");
        let og_description = extract_og_tag(&body, "og:description");
        let og_image = extract_og_tag(&body, "og:image");
        let og_site_name = extract_og_tag(&body, "og:site_name");

        let title = og_title.or_else(|| extract_title_tag(&body));

        CachedPreview {
            title,
            description: og_description,
            image: og_image,
            site_name: og_site_name,
        }
    };

    // Cache it
    {
        let mut cache = state.link_previews.write().await;
        cache.insert(url, preview.clone());
    }

    (
        StatusCode::OK,
        Json(serde_json::to_value(&preview).unwrap()),
    )
}
