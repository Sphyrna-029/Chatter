use super::super::{
    constants::CHUNK_SIZE,
    dto::{GifSearchQuery, LinkPreviewQuery},
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
use serde_json::{json, Value};
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::sync::Arc;

async fn check_storage_quota(
    state: &AppState,
    user_id: &str,
    incoming_size: u64,
) -> Result<(), (StatusCode, Json<Value>)> {
    let limit = state.server_settings.read().await.storage_limit_bytes;
    if limit == 0 {
        return Ok(());
    }

    let uploads_coll = state.db.collection::<UploadRecord>("uploads");
    let mut cursor = uploads_coll
        .find(doc! { "user_id": user_id })
        .await
        .map_err(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "DB error"))?;
    let mut current_total: u64 = 0;
    while let Ok(Some(record)) = cursor.try_next().await {
        current_total += record.size;
    }

    if current_total + incoming_size > limit {
        let used = format_bytes_short(current_total);
        let max = format_bytes_short(limit);
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            &format!("Storage quota exceeded (used {} of {})", used, max),
        ));
    }
    Ok(())
}

fn format_bytes_short(bytes: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = 1024 * KB;
    const GB: u64 = 1024 * MB;
    if bytes >= GB {
        format!("{:.1} GB", bytes as f64 / GB as f64)
    } else if bytes >= MB {
        format!("{:.1} MB", bytes as f64 / MB as f64)
    } else if bytes >= KB {
        format!("{:.1} KB", bytes as f64 / KB as f64)
    } else {
        format!("{} B", bytes)
    }
}

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

    // Validate and enforce limits for font files
    let ext_lower = filename.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    if ext_lower == "ttf" || ext_lower == "otf" || ext_lower == "woff" || ext_lower == "woff2" {
        if data.len() > 2 * 1024 * 1024 {
            return error_response(StatusCode::BAD_REQUEST, "Font file too large (max 2MB)");
        }
        if data.len() < 4 {
            return error_response(StatusCode::BAD_REQUEST, "File too small to be a valid font");
        }
        let magic = u32::from_be_bytes([data[0], data[1], data[2], data[3]]);
        let valid = matches!(
            magic,
            0x00010000  // TrueType
            | 0x4F54544F // OpenType (OTTO)
            | 0x774F4646 // WOFF
            | 0x774F4632 // WOFF2 (wOF2)
        );
        if !valid {
            return error_response(StatusCode::BAD_REQUEST, "File does not appear to be a valid font");
        }
    }

    let upload_limit = state.server_settings.read().await.upload_limit_bytes;
    if upload_limit > 0 && data.len() as u64 > upload_limit {
        return error_response(StatusCode::BAD_REQUEST, &format!("File too large (max {})", format_bytes_short(upload_limit)));
    }

    if let Err(e) = check_storage_quota(&state, &user_id, data.len() as u64).await {
        return e;
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
// Chunked upload
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize)]
pub(crate) struct ChunkedUploadInitBody {
    filename: String,
    #[serde(rename = "fileSize")]
    file_size: u64,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct ChunkMeta {
    filename: String,
    file_size: u64,
    user_id: String,
    chunk_count: u64,
}

pub(crate) async fn upload_init(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<ChunkedUploadInitBody>,
) -> impl IntoResponse {
    let token = match extract_token(&headers) {
        Some(t) => t,
        None => return error_response(StatusCode::UNAUTHORIZED, "Missing token"),
    };
    let user_id = match get_user_from_token(&state, &token) {
        Some(uid) => uid,
        None => return error_response(StatusCode::UNAUTHORIZED, "Invalid token"),
    };

    if body.file_size == 0 {
        return error_response(StatusCode::BAD_REQUEST, "Invalid file size");
    }
    let upload_limit = state.server_settings.read().await.upload_limit_bytes;
    if upload_limit > 0 && body.file_size > upload_limit {
        return error_response(StatusCode::BAD_REQUEST, &format!("File too large (max {})", format_bytes_short(upload_limit)));
    }

    if let Err(e) = check_storage_quota(&state, &user_id, body.file_size).await {
        return e;
    }

    let filename = body.filename.replace(['/', '\\', '\0'], "_");
    if filename.is_empty() {
        return error_response(StatusCode::BAD_REQUEST, "No filename provided");
    }

    let chunk_count = (body.file_size + CHUNK_SIZE as u64 - 1) / CHUNK_SIZE as u64;

    // Generate upload ID
    use rand::Rng;
    let bytes: [u8; 16] = rand::thread_rng().gen();
    let upload_id: String = bytes.iter().map(|b| format!("{:02x}", b)).collect();

    let chunk_dir = format!("external/.chunks/{}", upload_id);
    if tokio::fs::create_dir_all(&chunk_dir).await.is_err() {
        return error_response(StatusCode::INTERNAL_SERVER_ERROR, "Failed to create chunk dir");
    }

    // Write metadata sidecar
    let meta = ChunkMeta {
        filename,
        file_size: body.file_size,
        user_id,
        chunk_count,
    };
    let meta_path = format!("{}/meta.json", chunk_dir);
    if let Err(_) = tokio::fs::write(&meta_path, serde_json::to_string(&meta).unwrap()).await {
        return error_response(StatusCode::INTERNAL_SERVER_ERROR, "Failed to write metadata");
    }

    (
        StatusCode::OK,
        Json(json!({
            "uploadId": upload_id,
            "chunkSize": CHUNK_SIZE,
        })),
    )
}

pub(crate) async fn upload_chunk(
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

    let mut upload_id = String::new();
    let mut chunk_index: Option<u64> = None;
    let mut chunk_data = None;

    while let Ok(Some(field)) = multipart.next_field().await {
        let name = field.name().unwrap_or("").to_string();
        match name.as_str() {
            "uploadId" => {
                if let Ok(text) = field.text().await {
                    upload_id = text;
                }
            }
            "chunkIndex" => {
                if let Ok(text) = field.text().await {
                    chunk_index = text.parse().ok();
                }
            }
            "file" => {
                match field.bytes().await {
                    Ok(b) => chunk_data = Some(b),
                    Err(_) => return error_response(StatusCode::BAD_REQUEST, "Failed to read chunk"),
                }
            }
            _ => {}
        }
    }

    if upload_id.is_empty() || upload_id.len() != 32 || !upload_id.chars().all(|c| c.is_ascii_hexdigit()) {
        return error_response(StatusCode::BAD_REQUEST, "Invalid uploadId");
    }
    let chunk_index = match chunk_index {
        Some(i) => i,
        None => return error_response(StatusCode::BAD_REQUEST, "Missing chunkIndex"),
    };
    let chunk_data = match chunk_data {
        Some(d) => d,
        None => return error_response(StatusCode::BAD_REQUEST, "Missing file data"),
    };

    let chunk_dir = format!("external/.chunks/{}", upload_id);
    let meta_path = format!("{}/meta.json", chunk_dir);
    let meta_str = match tokio::fs::read_to_string(&meta_path).await {
        Ok(s) => s,
        Err(_) => return error_response(StatusCode::NOT_FOUND, "Upload not found"),
    };
    let meta: ChunkMeta = match serde_json::from_str(&meta_str) {
        Ok(m) => m,
        Err(_) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, "Corrupt metadata"),
    };

    if meta.user_id != user_id {
        return error_response(StatusCode::FORBIDDEN, "Not your upload");
    }
    if chunk_index >= meta.chunk_count {
        return error_response(StatusCode::BAD_REQUEST, "chunkIndex out of range");
    }

    let chunk_path = format!("{}/{}", chunk_dir, chunk_index);
    if tokio::fs::write(&chunk_path, &chunk_data).await.is_err() {
        return error_response(StatusCode::INTERNAL_SERVER_ERROR, "Failed to write chunk");
    }

    (StatusCode::OK, Json(json!({ "received": chunk_index })))
}

#[derive(serde::Deserialize)]
pub(crate) struct ChunkedUploadCompleteBody {
    #[serde(rename = "uploadId")]
    upload_id: String,
}

pub(crate) async fn upload_complete(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<ChunkedUploadCompleteBody>,
) -> impl IntoResponse {
    let token = match extract_token(&headers) {
        Some(t) => t,
        None => return error_response(StatusCode::UNAUTHORIZED, "Missing token"),
    };
    let user_id = match get_user_from_token(&state, &token) {
        Some(uid) => uid,
        None => return error_response(StatusCode::UNAUTHORIZED, "Invalid token"),
    };

    let upload_id = &body.upload_id;
    if upload_id.is_empty() || upload_id.len() != 32 || !upload_id.chars().all(|c| c.is_ascii_hexdigit()) {
        return error_response(StatusCode::BAD_REQUEST, "Invalid uploadId");
    }

    let chunk_dir = format!("external/.chunks/{}", upload_id);
    let meta_path = format!("{}/meta.json", chunk_dir);
    let meta_str = match tokio::fs::read_to_string(&meta_path).await {
        Ok(s) => s,
        Err(_) => return error_response(StatusCode::NOT_FOUND, "Upload not found"),
    };
    let meta: ChunkMeta = match serde_json::from_str(&meta_str) {
        Ok(m) => m,
        Err(_) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, "Corrupt metadata"),
    };

    if meta.user_id != user_id {
        return error_response(StatusCode::FORBIDDEN, "Not your upload");
    }

    // Verify all chunks are present
    for i in 0..meta.chunk_count {
        let chunk_path = format!("{}/{}", chunk_dir, i);
        if !tokio::fs::try_exists(&chunk_path).await.unwrap_or(false) {
            return error_response(StatusCode::BAD_REQUEST, &format!("Missing chunk {}", i));
        }
    }

    // Generate random folder and assemble final file
    use rand::Rng;
    let bytes: [u8; 16] = rand::thread_rng().gen();
    let folder: String = bytes.iter().map(|b| format!("{:02x}", b)).collect();

    let dir = format!("external/{}", folder);
    if tokio::fs::create_dir_all(&dir).await.is_err() {
        return error_response(StatusCode::INTERNAL_SERVER_ERROR, "Failed to create directory");
    }

    let filename = &meta.filename;
    let path = format!("{}/{}", dir, filename);

    // Concatenate chunks into final file
    let mut file = match tokio::fs::File::create(&path).await {
        Ok(f) => f,
        Err(_) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, "Failed to create file"),
    };

    use tokio::io::AsyncWriteExt;
    let mut total_size: u64 = 0;
    for i in 0..meta.chunk_count {
        let chunk_path = format!("{}/{}", chunk_dir, i);
        let chunk_data = match tokio::fs::read(&chunk_path).await {
            Ok(d) => d,
            Err(_) => {
                let _ = tokio::fs::remove_file(&path).await;
                return error_response(StatusCode::INTERNAL_SERVER_ERROR, "Failed to read chunk");
            }
        };
        total_size += chunk_data.len() as u64;
        if file.write_all(&chunk_data).await.is_err() {
            let _ = tokio::fs::remove_file(&path).await;
            return error_response(StatusCode::INTERNAL_SERVER_ERROR, "Failed to write file");
        }
    }

    // Clean up chunk dir
    let _ = tokio::fs::remove_dir_all(&chunk_dir).await;

    // Build URL
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
    let encoded_filename = utf8_percent_encode(filename, ENCODE_SET).to_string();

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

    // Track in MongoDB
    let record = UploadRecord {
        user_id: user_id.clone(),
        filename: filename.clone(),
        url: url.clone(),
        disk_path: path,
        size: total_size,
        uploaded_at: chrono::Utc::now().timestamp(),
    };
    let uploads_coll = state.db.collection::<UploadRecord>("uploads");
    let _ = uploads_coll.insert_one(record).await;

    (StatusCode::OK, Json(json!({ "url": url })))
}

// ---------------------------------------------------------------------------
// Link preview
// ---------------------------------------------------------------------------

/// Returns true if the IP address is private, loopback, link-local, or otherwise
/// reserved — i.e. should NOT be reachable from a server-side fetch.
fn is_private_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_loopback()          // 127.0.0.0/8
            || v4.is_private()        // 10/8, 172.16/12, 192.168/16
            || v4.is_link_local()     // 169.254/16
            || v4.is_broadcast()      // 255.255.255.255
            || v4.is_unspecified()    // 0.0.0.0
            || v4.octets()[0] == 100 && (v4.octets()[1] & 0xC0) == 64  // 100.64/10 (CGNAT)
            || v4.octets()[0] == 192 && v4.octets()[1] == 0 && v4.octets()[2] == 0 // 192.0.0/24 (IETF)
            || v4.octets()[0] == 198 && (v4.octets()[1] == 18 || v4.octets()[1] == 19) // 198.18/15 (benchmark)
        }
        IpAddr::V6(v6) => {
            v6.is_loopback()          // ::1
            || v6.is_unspecified()    // ::
            || {
                let segments = v6.segments();
                // fc00::/7  (unique local)
                (segments[0] & 0xFE00) == 0xFC00
                // fe80::/10 (link-local)
                || (segments[0] & 0xFFC0) == 0xFE80
                // ::ffff:0:0/96 (IPv4-mapped — check the embedded v4)
                || matches!(v6.to_ipv4_mapped(), Some(v4) if is_private_ip(&IpAddr::V4(v4)))
            }
        }
    }
}

/// Validate that a URL is safe for server-side fetching (no SSRF).
/// Returns the validated resolved addresses so they can be pinned for the actual fetch,
/// preventing DNS rebinding attacks.
fn validate_url_for_ssrf(url: &str) -> Result<Vec<SocketAddr>, &'static str> {
    let parsed = url::Url::parse(url).map_err(|_| "Invalid URL")?;

    // Only allow http/https
    match parsed.scheme() {
        "http" | "https" => {}
        _ => return Err("Only HTTP(S) URLs are allowed"),
    }

    let host = parsed.host_str().ok_or("URL has no host")?;

    // Resolve hostname to IPs and check every one
    let port = parsed.port_or_known_default().unwrap_or(80);
    let addr_str = format!("{}:{}", host, port);
    let addrs: Vec<_> = addr_str
        .to_socket_addrs()
        .map_err(|_| "Could not resolve hostname")?
        .collect();

    if addrs.is_empty() {
        return Err("Hostname resolved to no addresses");
    }

    for addr in &addrs {
        if is_private_ip(&addr.ip()) {
            return Err("URL resolves to a private/internal IP address");
        }
    }

    Ok(addrs)
}

/// Decode common HTML entities in a string, including numeric entities.
fn decode_html_entities(s: &str) -> String {
    let mut result = s
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&#x27;", "'")
        .replace("&#x2F;", "/")
        .replace("&nbsp;", " ")
        .replace("&mdash;", "\u{2014}")
        .replace("&ndash;", "\u{2013}")
        .replace("&laquo;", "\u{00AB}")
        .replace("&raquo;", "\u{00BB}")
        .replace("&hellip;", "\u{2026}")
        .replace("&rsquo;", "\u{2019}")
        .replace("&lsquo;", "\u{2018}")
        .replace("&rdquo;", "\u{201D}")
        .replace("&ldquo;", "\u{201C}");

    // Decode numeric entities: &#1234; and &#xABCD;
    let numeric_re = regex::Regex::new(r"&#(x?)([0-9a-fA-F]+);").unwrap();
    result = numeric_re.replace_all(&result, |caps: &regex::Captures| {
        let is_hex = !caps[1].is_empty();
        let num_str = &caps[2];
        let code = if is_hex {
            u32::from_str_radix(num_str, 16).ok()
        } else {
            num_str.parse::<u32>().ok()
        };
        code.and_then(char::from_u32)
            .map(|c| c.to_string())
            .unwrap_or_else(|| caps[0].to_string())
    }).to_string();

    result
}

/// Extract the <head> section from HTML to limit meta tag search scope.
fn extract_head_section(html: &str) -> &str {
    let lower = html.to_lowercase();
    let start = lower.find("<head").unwrap_or(0);
    let end = lower.find("</head>").map(|i| i + 7).unwrap_or(html.len());
    // Clamp end to 128KB to avoid scanning massive bodies
    let end = end.min(128 * 1024);
    &html[start..end.min(html.len())]
}

/// Extract an attribute value from a tag string, handling quotes and whitespace.
fn extract_attr_value(tag: &str, attr_name: &str) -> Option<String> {
    let target = attr_name.to_lowercase();

    // Use regex to flexibly match: attr_name\s*=\s*("val"|'val'|val)
    let pattern = format!(
        r#"(?i){}\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))"#,
        regex::escape(&target)
    );
    let re = regex::Regex::new(&pattern).ok()?;
    let caps = re.captures(tag)?;

    let val = caps.get(1)
        .or_else(|| caps.get(2))
        .or_else(|| caps.get(3))
        .map(|m| m.as_str().to_string())?;

    if val.is_empty() { return None; }
    Some(decode_html_entities(&val))
}

/// Find all <meta ...> tags in the HTML head section (case-insensitive).
/// Handles tags spanning multiple lines and self-closing tags.
fn find_meta_tags(html: &str) -> Vec<String> {
    let head = extract_head_section(html);
    let mut tags = Vec::new();
    let lower = head.to_lowercase();
    let mut search_from = 0;
    while let Some(start) = lower[search_from..].find("<meta") {
        let abs_start = search_from + start;
        // Find the end of this tag — handle both > and />
        if let Some(end) = head[abs_start..].find('>') {
            tags.push(head[abs_start..abs_start + end + 1].to_string());
            search_from = abs_start + end + 1;
        } else {
            break;
        }
    }
    tags
}

/// Check if a meta tag has a matching property or name attribute.
fn meta_tag_matches(tag: &str, attr_value: &str) -> bool {
    let target = attr_value.to_lowercase();
    for attr in &["property", "name"] {
        if let Some(val) = extract_attr_value(tag, attr) {
            if val.to_lowercase() == target {
                return true;
            }
        }
    }
    false
}

pub(crate) fn extract_og_tag(html: &str, property: &str) -> Option<String> {
    let meta_tags = find_meta_tags(html);
    for tag in &meta_tags {
        if meta_tag_matches(tag, property) {
            return extract_attr_value(tag, "content");
        }
    }
    None
}

/// Extract a meta tag by name attribute (e.g. "description", "twitter:title").
fn extract_meta_name(html: &str, name: &str) -> Option<String> {
    let meta_tags = find_meta_tags(html);
    for tag in &meta_tags {
        if meta_tag_matches(tag, name) {
            return extract_attr_value(tag, "content");
        }
    }
    None
}

pub(crate) fn extract_title_tag(html: &str) -> Option<String> {
    let head = extract_head_section(html);
    let lower = head.to_lowercase();
    let start = lower.find("<title")?;
    let rest = &head[start + 6..];
    let after_open = rest.find('>')? + 1;
    let end_lower = rest[after_open..].to_lowercase();
    let end = end_lower.find("</title>")?;
    let title = decode_html_entities(rest[after_open..after_open + end].trim());
    if title.is_empty() {
        return None;
    }
    Some(title)
}

/// Resolve a potentially relative URL against a base URL.
fn resolve_url(base: &str, href: &str) -> String {
    if href.starts_with("http://") || href.starts_with("https://") || href.starts_with("//") {
        if href.starts_with("//") {
            // Protocol-relative URL
            let scheme = if base.starts_with("https") { "https:" } else { "http:" };
            return format!("{}{}", scheme, href);
        }
        return href.to_string();
    }
    // Relative URL — resolve against base
    if let Ok(base_url) = url::Url::parse(base) {
        if let Ok(resolved) = base_url.join(href) {
            return resolved.to_string();
        }
    }
    href.to_string()
}

/// Build a reqwest client with DNS pinned to the validated addresses, preventing
/// DNS rebinding attacks (the client will connect to the exact IPs we already checked).
fn build_pinned_client(url: &str, validated_addrs: &[SocketAddr]) -> Result<reqwest::Client, String> {
    let parsed = url::Url::parse(url).map_err(|e| e.to_string())?;
    let host = parsed.host_str().ok_or("URL has no host")?;

    let mut builder = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .gzip(true)
        .brotli(true)
        .deflate(true);

    for addr in validated_addrs {
        builder = builder.resolve(host, *addr);
    }

    builder.build().map_err(|e| e.to_string())
}

/// Fetch a URL following redirects, validating each hop against SSRF.
/// Uses pre-validated addresses pinned into the client to prevent DNS rebinding.
async fn safe_fetch(
    initial_url: &str,
    validated_addrs: &[SocketAddr],
    ua: &str,
    accept: &str,
) -> Result<reqwest::Response, String> {
    let mut current_url = initial_url.to_string();
    let mut current_addrs = validated_addrs.to_vec();

    for _ in 0..5u8 {
        let client = build_pinned_client(&current_url, &current_addrs)?;

        let resp = client
            .get(&current_url)
            .header("User-Agent", ua)
            .header("Accept", accept)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if resp.status().is_redirection() {
            if let Some(loc) = resp.headers().get("location").and_then(|v| v.to_str().ok()) {
                let next = if loc.starts_with('/') {
                    let base = url::Url::parse(&current_url).map_err(|e| e.to_string())?;
                    base.join(loc).map_err(|e| e.to_string())?.to_string()
                } else {
                    loc.to_string()
                };
                // Resolve and validate the redirect target, getting fresh pinned addrs
                current_addrs = validate_url_for_ssrf(&next).map_err(|e| e.to_string())?;
                current_url = next;
                continue;
            }
        }
        return Ok(resp);
    }
    Err("Too many redirects".to_string())
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

    // SSRF protection: resolve DNS once and validate all IPs, then pin them for the fetch
    let validated_addrs = match validate_url_for_ssrf(&url) {
        Ok(addrs) => addrs,
        Err(msg) => return error_response(StatusCode::BAD_REQUEST, msg),
    };

    let browser_ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

    let is_twitter = url.contains("twitter.com/") || url.contains("x.com/");
    let preview = if is_twitter {
        let oembed_url = format!(
            "https://publish.twitter.com/oembed?url={}&omit_script=true",
            urlencoding::encode(&url)
        );
        // The oembed URL goes to publish.twitter.com which is a known safe host;
        // validate and pin it separately
        let oembed_addrs = match validate_url_for_ssrf(&oembed_url) {
            Ok(addrs) => addrs,
            Err(msg) => return error_response(StatusCode::BAD_REQUEST, msg),
        };
        match safe_fetch(&oembed_url, &oembed_addrs, browser_ua, "application/json").await {
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
        let response = match safe_fetch(
            &url,
            &validated_addrs,
            browser_ua,
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        )
        .await
        {
            Ok(r) => r,
            Err(_) => return error_response(StatusCode::BAD_GATEWAY, "Failed to fetch URL"),
        };

        // Detect charset from Content-Type header for proper decoding
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_lowercase();

        let body_bytes = match response.bytes().await {
            Ok(b) => b,
            Err(_) => return error_response(StatusCode::BAD_GATEWAY, "Failed to read response"),
        };

        // Limit to 512KB for parsing
        let bytes_to_parse = if body_bytes.len() > 512 * 1024 {
            &body_bytes[..512 * 1024]
        } else {
            &body_bytes[..]
        };

        // Try to detect encoding from Content-Type header or meta charset tag
        let body = if content_type.contains("iso-8859-1") || content_type.contains("latin1") || content_type.contains("windows-1252") {
            // Decode as Latin-1 (each byte maps directly to a Unicode code point)
            bytes_to_parse.iter().map(|&b| b as char).collect::<String>()
        } else {
            String::from_utf8_lossy(bytes_to_parse).to_string()
        };

        // Try OG tags first, then twitter: card tags, then plain meta tags, then <title>
        let title = extract_og_tag(&body, "og:title")
            .or_else(|| extract_meta_name(&body, "twitter:title"))
            .or_else(|| extract_meta_name(&body, "title"))
            .or_else(|| extract_title_tag(&body));

        let description = extract_og_tag(&body, "og:description")
            .or_else(|| extract_meta_name(&body, "twitter:description"))
            .or_else(|| extract_meta_name(&body, "description"));

        // Resolve relative image URLs to absolute
        let image = extract_og_tag(&body, "og:image")
            .or_else(|| extract_meta_name(&body, "twitter:image"))
            .or_else(|| extract_meta_name(&body, "twitter:image:src"))
            .map(|img| resolve_url(&url, &img));

        let site_name = extract_og_tag(&body, "og:site_name")
            .or_else(|| extract_meta_name(&body, "twitter:site"))
            .or_else(|| extract_meta_name(&body, "application-name"));

        CachedPreview {
            title,
            description,
            image,
            site_name,
        }
    };

    // Only cache if there's actual content — don't cache empty results forever
    let has_content = preview.title.is_some()
        || preview.description.is_some()
        || preview.image.is_some();

    if has_content {
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

// ---------------------------------------------------------------------------
// GIF search (Klipy proxy)
// ---------------------------------------------------------------------------

pub(crate) async fn gif_search(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<GifSearchQuery>,
) -> impl IntoResponse {
    let token = match extract_token(&headers) {
        Some(t) => t,
        None => return error_response(StatusCode::UNAUTHORIZED, "Missing token"),
    };
    if get_user_from_token(&state, &token).is_none() {
        return error_response(StatusCode::UNAUTHORIZED, "Invalid token");
    }

    if state.klipy_api_key.is_empty() {
        return error_response(StatusCode::SERVICE_UNAVAILABLE, "GIF search not configured");
    }

    let page = query.page.unwrap_or(1);
    let per_page = query.per_page.unwrap_or(24).min(50);
    let q = query.q.unwrap_or_default();

    let url = if q.trim().is_empty() {
        format!(
            "https://api.klipy.com/api/v1/{}/gifs/trending?page={}&per_page={}",
            state.klipy_api_key, page, per_page
        )
    } else {
        format!(
            "https://api.klipy.com/api/v1/{}/gifs/search?q={}&page={}&per_page={}",
            state.klipy_api_key,
            urlencoding::encode(q.trim()),
            page,
            per_page
        )
    };

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(_) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, "HTTP client error"),
    };

    match client.get(&url).send().await {
        Ok(resp) => match resp.json::<serde_json::Value>().await {
            Ok(json) => (StatusCode::OK, Json(json)),
            Err(_) => error_response(StatusCode::BAD_GATEWAY, "Invalid response from GIF API"),
        },
        Err(_) => error_response(StatusCode::BAD_GATEWAY, "Failed to reach GIF API"),
    }
}

pub(crate) async fn serve_upload(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path((folder, filename)): Path<(String, String)>,
) -> Response<Body> {
    if folder.contains("..") || filename.contains("..") {
        return Response::builder()
            .status(StatusCode::BAD_REQUEST)
            .body(Body::from("Invalid path"))
            .unwrap();
    }

    // Check if authentication is required for uploads
    let require_auth = state.server_settings.read().await.require_auth_for_uploads;
    if require_auth {
        let token = extract_token(&headers);
        let authed = match token {
            Some(t) => get_user_from_token(&state, &t).is_some(),
            None => false,
        };
        if !authed {
            return Response::builder()
                .status(StatusCode::UNAUTHORIZED)
                .header(header::CONTENT_TYPE, "text/plain")
                .body(Body::from("Unauthorized"))
                .unwrap();
        }
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
