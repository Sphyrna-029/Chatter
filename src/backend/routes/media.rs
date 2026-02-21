use super::super::{
    constants::MAX_UPLOAD_SIZE,
    dto::LinkPreviewQuery,
    helpers::{error_response, extract_token, get_user_from_token},
    state::{AppState, CachedPreview, UploadRecord},
};
use axum::{
    extract::{Multipart, Path, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Json, Response},
    body::Body,
};
use futures_util::TryStreamExt;
use mongodb::bson::doc;
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
    let user_id = match get_user_from_token(&state, &token) {
        Some(uid) => uid,
        None => return error_response(StatusCode::UNAUTHORIZED, "Invalid token"),
    };

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

    // Track the upload in MongoDB
    let record = UploadRecord {
        user_id: user_id.clone(),
        filename: filename.clone(),
        url: url.clone(),
        disk_path: path,
        size: data.len() as u64,
        uploaded_at: chrono::Utc::now().timestamp(),
    };
    let uploads_coll = state.db.collection::<UploadRecord>("uploads");
    let _ = uploads_coll.insert_one(record).await;

    (StatusCode::OK, Json(json!({ "url": url })))
}

// ---------------------------------------------------------------------------
// Link preview
// ---------------------------------------------------------------------------

pub(crate) fn extract_og_tag(html: &str, property: &str) -> Option<String> {
    let pattern = format!("property=\"{}\"", property);
    let pos = html.find(&pattern)?;
    let snippet = &html[pos..];
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
    if get_user_from_token(&state, &token).is_none() {
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

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    let browser_ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

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

// ---------------------------------------------------------------------------
// User uploads list & delete
// ---------------------------------------------------------------------------

pub(crate) async fn list_uploads(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let token = match extract_token(&headers) {
        Some(t) => t,
        None => return error_response(StatusCode::UNAUTHORIZED, "Missing token"),
    };
    let user_id = match get_user_from_token(&state, &token) {
        Some(uid) => uid,
        None => return error_response(StatusCode::UNAUTHORIZED, "Invalid token"),
    };

    let uploads_coll = state.db.collection::<UploadRecord>("uploads");
    let mut files: Vec<serde_json::Value> = Vec::new();

    if let Ok(mut cursor) = uploads_coll.find(doc! { "user_id": &user_id }).await {
        while let Ok(Some(record)) = cursor.try_next().await {
            files.push(json!({
                "filename": record.filename,
                "url": record.url,
                "disk_path": record.disk_path,
                "size": record.size,
                "uploaded_at": record.uploaded_at,
            }));
        }
    }

    (StatusCode::OK, Json(json!({ "files": files })))
}

#[derive(serde::Deserialize)]
pub(crate) struct DeleteUploadBody {
    url: String,
}

pub(crate) async fn delete_upload(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<DeleteUploadBody>,
) -> impl IntoResponse {
    let token = match extract_token(&headers) {
        Some(t) => t,
        None => return error_response(StatusCode::UNAUTHORIZED, "Missing token"),
    };
    let user_id = match get_user_from_token(&state, &token) {
        Some(uid) => uid,
        None => return error_response(StatusCode::UNAUTHORIZED, "Invalid token"),
    };

    let uploads_coll = state.db.collection::<UploadRecord>("uploads");
    let record = uploads_coll
        .find_one_and_delete(doc! { "user_id": &user_id, "url": &body.url })
        .await
        .ok()
        .flatten();

    match record {
        Some(rec) => {
            let _ = tokio::fs::remove_file(&rec.disk_path).await;
            if let Some(parent) = std::path::Path::new(&rec.disk_path).parent() {
                let _ = tokio::fs::remove_dir(parent).await;
            }
            (StatusCode::OK, Json(json!({ "deleted": true })))
        }
        None => error_response(StatusCode::NOT_FOUND, "File not found"),
    }
}

// ---------------------------------------------------------------------------
// Serve uploaded files with safe Content-Type
// ---------------------------------------------------------------------------

fn is_dangerous_extension(ext: &str) -> bool {
    matches!(
        ext,
        "html" | "htm" | "xhtml" | "js" | "mjs" | "cjs" | "ts"
            | "css" | "svg" | "xml" | "xsl" | "xslt"
            | "wasm" | "crx" | "swf"
    )
}

pub(crate) async fn serve_upload(
    Path((folder, filename)): Path<(String, String)>,
) -> Response<Body> {
    if folder.contains("..") || filename.contains("..") {
        return Response::builder()
            .status(StatusCode::BAD_REQUEST)
            .body(Body::from("Invalid path"))
            .unwrap();
    }

    let path = format!("external/{}/{}", folder, filename);
    let data = match tokio::fs::read(&path).await {
        Ok(d) => d,
        Err(_) => {
            return Response::builder()
                .status(StatusCode::NOT_FOUND)
                .body(Body::from("Not found"))
                .unwrap();
        }
    };

    let ext = filename
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();

    let content_type = if is_dangerous_extension(&ext) {
        "text/plain".to_string()
    } else {
        mime_guess::from_ext(&ext)
            .first_or_octet_stream()
            .to_string()
    };

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .header(
            header::CONTENT_DISPOSITION,
            format!("inline; filename=\"{}\"", filename),
        )
        .body(Body::from(data))
        .unwrap()
}
