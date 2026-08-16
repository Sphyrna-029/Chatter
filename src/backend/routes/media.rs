use super::super::{
    constants::CHUNK_SIZE,
    dto::{GifSearchQuery, LinkPreviewQuery},
    helpers::{error_response, extract_token, get_user_from_token},
    state::{AppState, CachedPreview, UploadRecord},
};
use axum::{
    extract::{Multipart, Query, State},
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

/// Post-process uploaded video files for browser compatibility:
/// - MKV/AVI/WMV → remux to MP4 (copies video, transcodes audio to AAC)
/// - MP4/MOV → apply faststart (move moov atom to front for instant playback)
/// Returns the (possibly new) file path and filename if the file was converted.
async fn postprocess_video(path: &str, filename: &str) -> (String, String) {
    let ext = filename
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();

    // Convert non-browser formats to MP4
    if matches!(ext.as_str(), "mkv" | "avi" | "wmv" | "flv" | "ts") {
        let new_filename = format!(
            "{}.mp4",
            filename.rsplit_once('.').map(|(base, _)| base).unwrap_or(filename)
        );
        let dir = path.rsplit_once('/').map(|(d, _)| d).unwrap_or(".");
        let new_path = format!("{}/{}", dir, new_filename);
        let result = tokio::process::Command::new("ffmpeg")
            .args([
                "-y", "-i", path,
                "-map", "0:v:0",
                "-map", "0:a:0",
                "-c:v", "copy",
                "-c:a", "aac",
                "-ac", "2",
                "-movflags", "+faststart",
                &new_path,
            ])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .await;
        if let Ok(status) = result {
            if status.success() {
                let _ = tokio::fs::remove_file(path).await;
                return (new_path, new_filename);
            }
        }
        // Conversion failed — clean up and keep original
        let _ = tokio::fs::remove_file(&new_path).await;
        return (path.to_string(), filename.to_string());
    }

    // For MP4/MOV, just apply faststart
    if matches!(ext.as_str(), "mp4" | "mov" | "m4v" | "m4a") {
        let tmp = format!("{}.faststart.tmp", path);
        let result = tokio::process::Command::new("ffmpeg")
            .args(["-y", "-i", path, "-c", "copy", "-movflags", "+faststart", &tmp])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .await;
        if let Ok(status) = result {
            if status.success() {
                let _ = tokio::fs::rename(&tmp, path).await;
                return (path.to_string(), filename.to_string());
            }
        }
        let _ = tokio::fs::remove_file(&tmp).await;
    }

    (path.to_string(), filename.to_string())
}

/// Extract the first frame of a video as a JPEG thumbnail.
/// Saves to `{path}.thumb.jpg` next to the video file.
async fn generate_thumbnail(path: &str) {
    let thumb_path = format!("{}.thumb.jpg", path);
    if tokio::fs::metadata(&thumb_path).await.is_ok() {
        return; // already exists
    }
    let _ = tokio::process::Command::new("ffmpeg")
        .args([
            "-y", "-i", path,
            "-vframes", "1",
            "-vf", "scale=320:-1",
            "-q:v", "6",
            &thumb_path,
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .await;
}

/// Return true for still-image extensions that benefit from a downscaled WebP
/// preview. GIFs are excluded (animation must be preserved); SVGs are excluded
/// because they are blocked as dangerous extensions.
fn is_previewable_image(ext: &str) -> bool {
    matches!(ext, "jpg" | "jpeg" | "png" | "webp" | "bmp" | "tiff")
}

/// Produce a downscaled, re-encoded WebP preview of a still image so clients
/// can load a lightweight version quickly. Saves to `{path}.preview.webp`
/// next to the original. Mirrors the video `.thumb.jpg` sidecar convention.
async fn generate_image_preview(path: &str) {
    let preview_path = format!("{}.preview.webp", path);
    if tokio::fs::metadata(&preview_path).await.is_ok() {
        return; // already exists
    }
    let _ = tokio::process::Command::new("ffmpeg")
        .args([
            "-y", "-i", path,
            "-vframes", "1",
            "-vf", "scale=1024:1024:force_original_aspect_ratio=decrease",
            "-quality", "80",
            &preview_path,
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .await;
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

    // Convert to browser-compatible format / apply faststart
    let (path, filename) = postprocess_video(&path, &filename).await;

    // Generate first-frame thumbnail for video files
    let vid_ext = filename.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    if matches!(vid_ext.as_str(), "mp4" | "mov" | "m4v" | "webm" | "ogg") {
        generate_thumbnail(&path).await;
    }

    // Generate a downscaled WebP preview for still images
    let img_ext = filename.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    if is_previewable_image(&img_ext) {
        generate_image_preview(&path).await;
    }

    // Recalculate file size after potential conversion
    let final_size = tokio::fs::metadata(&path)
        .await
        .map(|m| m.len())
        .unwrap_or(data.len() as u64);

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
        size: final_size,
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

    // Flush the file handle before post-processing
    drop(file);

    // Convert to browser-compatible format / apply faststart
    let (path, filename) = postprocess_video(&path, filename).await;

    // Generate first-frame thumbnail for video files
    let vid_ext = filename.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    if matches!(vid_ext.as_str(), "mp4" | "mov" | "m4v" | "webm" | "ogg") {
        generate_thumbnail(&path).await;
    }

    // Generate a downscaled WebP preview for still images
    let img_ext = filename.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    if is_previewable_image(&img_ext) {
        generate_image_preview(&path).await;
    }

    // Recalculate file size after potential conversion
    let final_size = tokio::fs::metadata(&path)
        .await
        .map(|m| m.len())
        .unwrap_or(total_size);

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

    // Track in MongoDB
    let record = UploadRecord {
        user_id: user_id.clone(),
        filename: filename.clone(),
        url: url.clone(),
        disk_path: path,
        size: final_size,
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
/// Uses a regex to avoid byte-offset mismatches from case-folding multi-byte chars.
fn extract_head_section(html: &str) -> &str {
    // Clamp scan to 128KB
    let haystack = if html.len() > 128 * 1024 { &html[..128 * 1024] } else { html };
    let head_re = regex::Regex::new(r"(?is)<head[\s>].*?</head>").unwrap();
    if let Some(m) = head_re.find(haystack) {
        return m.as_str();
    }
    // No explicit <head> — scan the whole clamped region (common on minimal pages)
    haystack
}

/// Extract an attribute value from a tag string, handling quotes, whitespace, and newlines.
fn extract_attr_value(tag: &str, attr_name: &str) -> Option<String> {
    let target = attr_name.to_lowercase();

    // Use regex with (?s) to handle newlines inside tags
    let pattern = format!(
        r#"(?is){}\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))"#,
        regex::escape(&target)
    );
    let re = regex::Regex::new(&pattern).ok()?;
    let caps = re.captures(tag)?;

    let val = caps.get(1)
        .or_else(|| caps.get(2))
        .or_else(|| caps.get(3))
        .map(|m| m.as_str().trim().to_string())?;

    if val.is_empty() { return None; }
    Some(decode_html_entities(&val))
}

/// Find all <meta ...> tags in the HTML head section (case-insensitive).
/// Uses regex to properly handle multi-line tags and multi-byte chars.
fn find_meta_tags(html: &str) -> Vec<String> {
    let head = extract_head_section(html);
    let meta_re = regex::Regex::new(r"(?is)<meta\s[^>]*>").unwrap();
    meta_re.find_iter(head).map(|m| m.as_str().to_string()).collect()
}

/// Check if a meta tag has a matching property, name, or itemprop attribute.
fn meta_tag_matches(tag: &str, attr_value: &str) -> bool {
    let target = attr_value.to_lowercase();
    for attr in &["property", "name", "itemprop"] {
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
    let title_re = regex::Regex::new(r"(?is)<title[^>]*>(.*?)</title>").unwrap();
    let caps = title_re.captures(head)?;
    let title = decode_html_entities(caps[1].trim());
    if title.is_empty() { return None; }
    Some(title)
}

/// Detect charset declared in HTML meta tags (e.g. <meta charset="..."> or
/// <meta http-equiv="Content-Type" content="...; charset=...">) .
fn detect_html_charset(html: &str) -> Option<String> {
    let meta_tags = find_meta_tags(html);
    for tag in &meta_tags {
        // <meta charset="...">
        if let Some(cs) = extract_attr_value(tag, "charset") {
            return Some(cs.to_lowercase());
        }
        // <meta http-equiv="Content-Type" content="text/html; charset=...">
        if let Some(equiv) = extract_attr_value(tag, "http-equiv") {
            if equiv.eq_ignore_ascii_case("content-type") {
                if let Some(content) = extract_attr_value(tag, "content") {
                    let lower = content.to_lowercase();
                    if let Some(pos) = lower.find("charset=") {
                        let cs = lower[pos + 8..].split(';').next().unwrap_or("").trim().to_string();
                        if !cs.is_empty() { return Some(cs); }
                    }
                }
            }
        }
    }
    None
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
            .header("Accept-Language", "en-US,en;q=0.9")
            .header("Accept-Encoding", "gzip, deflate, br")
            .header("Cache-Control", "no-cache")
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

    // Use a well-known link-preview bot UA — sites whitelist these for OG tag serving
    // (Twitterbot and Discordbot are universally allowed, unlike Googlebot which gets 403'd)
    let browser_ua = "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)";

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
        // Try with primary UA; if it fails (e.g. 403), retry with fallback UA
        let accept_html = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
        let fallback_ua = "Twitterbot/1.0";

        let response = match safe_fetch(&url, &validated_addrs, browser_ua, accept_html).await {
            Ok(r) if r.status().is_success() => r,
            _ => {
                // Retry with fallback UA
                match safe_fetch(&url, &validated_addrs, fallback_ua, accept_html).await {
                    Ok(r) if r.status().is_success() => r,
                    _ => {
                        return (StatusCode::OK, Json(serde_json::to_value(&CachedPreview {
                            title: None, description: None, image: None, site_name: None,
                        }).unwrap()));
                    }
                }
            }
        };

        // Detect charset from Content-Type header for proper decoding
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_lowercase();

        // Bail early for non-HTML content types (e.g. JSON APIs, PDFs, binaries)
        let is_html = content_type.is_empty()
            || content_type.contains("text/html")
            || content_type.contains("application/xhtml");
        if !is_html {
            return (StatusCode::OK, Json(serde_json::to_value(&CachedPreview {
                title: None, description: None, image: None, site_name: None,
            }).unwrap()));
        }

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

        // Try to detect encoding from Content-Type header or HTML meta charset tag
        // First do a lossy UTF-8 pass to find charset in meta tags
        let lossy = String::from_utf8_lossy(bytes_to_parse);
        let html_charset = detect_html_charset(&lossy);

        let is_latin = content_type.contains("iso-8859-1")
            || content_type.contains("latin1")
            || content_type.contains("windows-1252")
            || matches!(html_charset.as_deref(), Some("iso-8859-1" | "latin1" | "latin-1" | "windows-1252"));

        let body = if is_latin {
            // Decode as Latin-1 (each byte maps directly to a Unicode code point)
            bytes_to_parse.iter().map(|&b| b as char).collect::<String>()
        } else {
            lossy.into_owned()
        };

        // Try OG tags first, then twitter: card tags, then plain meta tags, then <title>
        let title = extract_og_tag(&body, "og:title")
            .or_else(|| extract_meta_name(&body, "twitter:title"))
            .or_else(|| extract_meta_name(&body, "title"))
            .or_else(|| extract_meta_name(&body, "dc.title"))
            .or_else(|| extract_title_tag(&body));

        let description = extract_og_tag(&body, "og:description")
            .or_else(|| extract_meta_name(&body, "twitter:description"))
            .or_else(|| extract_meta_name(&body, "description"))
            .or_else(|| extract_meta_name(&body, "dc.description"));

        // Resolve relative image URLs to absolute
        let image = extract_og_tag(&body, "og:image")
            .or_else(|| extract_og_tag(&body, "og:image:url"))
            .or_else(|| extract_og_tag(&body, "og:image:secure_url"))
            .or_else(|| extract_meta_name(&body, "twitter:image"))
            .or_else(|| extract_meta_name(&body, "twitter:image:src"))
            .or_else(|| extract_meta_name(&body, "thumbnail"))
            .map(|img| resolve_url(&url, &img));

        let site_name = extract_og_tag(&body, "og:site_name")
            .or_else(|| extract_meta_name(&body, "twitter:site"))
            .or_else(|| extract_meta_name(&body, "application-name"))
            .or_else(|| extract_meta_name(&body, "al:android:app_name"))
            .or_else(|| extract_meta_name(&body, "al:ios:app_name"))
            .or_else(|| {
                // Fall back to extracting domain name from URL
                url::Url::parse(&url).ok()
                    .and_then(|u| u.host_str().map(|h| {
                        // Strip www. prefix
                        h.strip_prefix("www.").unwrap_or(h).to_string()
                    }))
            });

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

/// Middleware for uploaded file requests: auth check, dangerous extension
/// blocking, and MKV→MP4 conversion. Safe files pass through to ServeDir.
pub(crate) async fn upload_guard(
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response<Body> {
    // Auth check — extract state from request extensions
    if let Some(state) = req.extensions().get::<Arc<AppState>>() {
        let require_auth = state.server_settings.read().await.require_auth_for_uploads;
        if require_auth {
            // Auth priority: Authorization header → media_session HttpOnly cookie.
            // <video>/<audio> elements cannot send custom headers; they rely on the
            // media_session cookie (Path=/external) that the browser sends automatically.
            // The old ?access_token= query-param path has been removed to prevent tokens
            // from leaking into server logs and browser history.
            let token = extract_token(req.headers()).or_else(|| {
                req.headers()
                    .get(header::COOKIE)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|s| {
                        s.split(';').find_map(|part| {
                            let part = part.trim();
                            part.strip_prefix("media_session=").map(String::from)
                        })
                    })
            });
            let authed = match token {
                Some(t) => get_user_from_token(state, &t).is_some(),
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
    }

    let uri_path = req.uri().path().to_string();
    let ext = uri_path
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();

    // Block dangerous file extensions by serving as plain text
    if is_dangerous_extension(&ext) {
        // Construct disk path: the URI under /external nest is /{folder}/{filename}
        let relative = uri_path.trim_start_matches('/');
        let disk_path = format!("external/{}", relative);
        let data = match tokio::fs::read(&disk_path).await {
            Ok(d) => d,
            Err(_) => {
                return Response::builder()
                    .status(StatusCode::NOT_FOUND)
                    .body(Body::from("Not found"))
                    .unwrap();
            }
        };
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/plain")
            .body(Body::from(data))
            .unwrap();
    }

    // Generate thumbnail on demand when the .thumb.jpg is requested
    if uri_path.ends_with(".thumb.jpg") {
        let relative = uri_path.trim_start_matches('/');
        let thumb_disk = format!("external/{}", relative);
        if tokio::fs::metadata(&thumb_disk).await.is_err() {
            // Derive video path by stripping ".thumb.jpg"
            let video_disk = thumb_disk.strip_suffix(".thumb.jpg").unwrap_or(&thumb_disk);
            generate_thumbnail(video_disk).await;
        }
    }

    // Generate a WebP preview on demand when the .preview.webp is requested
    if uri_path.ends_with(".preview.webp") {
        let relative = uri_path.trim_start_matches('/');
        let preview_disk = format!("external/{}", relative);
        if tokio::fs::metadata(&preview_disk).await.is_err() {
            let source_disk = preview_disk.strip_suffix(".preview.webp").unwrap_or(&preview_disk);
            generate_image_preview(source_disk).await;
        }
    }

    // For MP4/MOV files, apply faststart on first access so the moov atom
    // is at the front of the file — required for instant seeking in browsers.
    // Also generate a thumbnail if one doesn't exist yet.
    if matches!(ext.as_str(), "mp4" | "mov" | "m4v" | "webm" | "ogg") {
        let relative = uri_path.trim_start_matches('/');
        let disk_path = format!("external/{}", relative);

        if matches!(ext.as_str(), "mp4" | "mov" | "m4v") {
            let marker = format!("{}.faststarted", disk_path);
            if tokio::fs::metadata(&marker).await.is_err() {
                if tokio::fs::metadata(&disk_path).await.is_ok() {
                    let tmp = format!("{}.faststart.tmp", disk_path);
                    let result = tokio::process::Command::new("ffmpeg")
                        .args(["-y", "-i", &disk_path, "-c", "copy", "-movflags", "+faststart", &tmp])
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null())
                        .status()
                        .await;
                    if let Ok(status) = result {
                        if status.success() {
                            let _ = tokio::fs::rename(&tmp, &disk_path).await;
                        }
                    }
                    let _ = tokio::fs::remove_file(&tmp).await;
                    let _ = tokio::fs::write(&marker, b"").await;
                }
            }
        }

        // Lazily generate thumbnail for existing videos
        generate_thumbnail(&disk_path).await;
    }

    // For non-browser video formats, convert to MP4 on first access
    // then rewrite the request URI so ServeDir serves the MP4
    if matches!(ext.as_str(), "mkv" | "avi" | "wmv" | "flv" | "ts") {
        let relative = uri_path.trim_start_matches('/');
        let disk_path = format!("external/{}", relative);
        let base = uri_path.rsplit_once('.').map(|(b, _)| b).unwrap_or(&uri_path);
        let mp4_uri = format!("{}.mp4", base);
        let mp4_disk = format!("external{}.mp4", base);

        // Convert if cached MP4 doesn't exist yet
        if tokio::fs::metadata(&mp4_disk).await.is_err() {
            if tokio::fs::metadata(&disk_path).await.is_ok() {
                let _ = tokio::process::Command::new("ffmpeg")
                    .args([
                        "-y", "-i", &disk_path,
                        "-map", "0:v:0",
                        "-map", "0:a:0",
                        "-c:v", "copy", "-c:a", "aac",
                        "-ac", "2",
                        "-movflags", "+faststart",
                        &mp4_disk,
                    ])
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status()
                    .await;
            }
        }

        // If MP4 exists, rewrite request to serve it
        if tokio::fs::metadata(&mp4_disk).await.is_ok() {
            let (mut parts, body) = req.into_parts();
            parts.uri = mp4_uri.parse().unwrap_or(parts.uri);
            let req = axum::http::Request::from_parts(parts, body);
            return next.run(req).await.into_response();
        }
    }

    // Pass through to ServeDir
    next.run(req).await.into_response()
}
