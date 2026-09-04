use super::super::{
    constants::CHUNK_SIZE,
    dto::{GifSearchQuery, LinkPreviewQuery},
    helpers::{error_response, extract_token, get_user_from_token},
    state::{AppState, CachedPreview, UploadRecord},
};
use axum::{
    body::Body,
    extract::{Multipart, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Json, Response},
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
///
/// Returns the (possibly new) file path and filename if the file was converted.
async fn postprocess_video(path: &str, filename: &str) -> (String, String) {
    let ext = filename
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();

    // Convert non-browser formats to MP4 (subtitle streams preserved as mov_text)
    if matches!(ext.as_str(), "mkv" | "avi" | "wmv" | "flv" | "ts") {
        let new_path = format!(
            "{}.mp4",
            path.rsplit_once('.').map(|(b, _)| b).unwrap_or(path)
        );
        if let Some(tmp_path) = remux_with_subs(path).await {
            let _ = tokio::fs::rename(&tmp_path, &new_path).await;
            let _ = tokio::fs::remove_file(path).await;
            let new_filename = new_filename_from_path(&new_path);
            return (new_path, new_filename);
        }
        // Conversion failed — clean up and keep original
        let _ = tokio::fs::remove_file(&format!("{}.cc.tmp", path)).await;
        return (path.to_string(), filename.to_string());
    }

    // For MP4/MOV, apply faststart
    if matches!(ext.as_str(), "mp4" | "mov" | "m4v") {
        let tmp = format!("{}.faststart.tmp", path);
        let result = tokio::process::Command::new("ffmpeg")
            .args([
                "-y",
                "-i",
                path,
                "-c",
                "copy",
                "-movflags",
                "+faststart",
                &tmp,
            ])
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

fn new_filename_from_path(path: &str) -> String {
    path.rsplit('/').next().unwrap_or("").to_string()
}

/// Subtitle codecs that can be exposed as WebVTT (text-based subtitles).
fn is_text_subtitle_codec(codec: &str) -> bool {
    matches!(
        codec,
        "webvtt" | "mov_text" | "ass" | "ssa" | "srt" | "subrip" | "sbv" | "text"
    )
}

/// Remux a video with text-based subtitle streams into an MP4 copy
/// (video/audio copied, subtitles as mov_text). Output is written to
/// `{src}.cc.tmp`; the caller renames into place. Returns the tmp path.
async fn remux_with_subs(src: &str) -> Option<String> {
    let dst = format!("{}.cc.tmp", src);
    let _ = tokio::fs::remove_file(&dst).await;
    let result = tokio::process::Command::new("ffmpeg")
        .args([
            "-y",
            "-i",
            src,
            "-map",
            "0:v:0",
            "-map",
            "0:a?",
            "-map",
            "0:s?",
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-ac",
            "2",
            "-c:s",
            "mov_text",
            "-movflags",
            "+faststart",
            &dst,
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .await;
    match result {
        Ok(s) if s.success() && tokio::fs::metadata(&dst).await.is_ok() => Some(dst),
        _ => {
            let _ = tokio::fs::remove_file(&dst).await;
            None
        }
    }
}

/// Extract a representative frame of a video as a JPEG thumbnail.
/// Frame 0 of many recordings is black, so the sample point is chosen
/// from the video duration (via ffprobe) before grabbing the frame.
/// Saves to `{path}.thumb.jpg` next to the video file.
async fn generate_thumbnail(path: &str) {
    let thumb_path = format!("{}.thumb.jpg", path);
    if tokio::fs::metadata(&thumb_path).await.is_ok() {
        return; // already exists
    }

    async fn run_ffmpeg(args: &[String]) -> bool {
        tokio::process::Command::new("ffmpeg")
            .arg("-y")
            .args(args)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .await
            .map(|s| s.success())
            .unwrap_or(false)
    }

    // Probe duration to pick candidate sample points across the video.
    let duration: f64 = tokio::process::Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            path,
        ])
        .output()
        .await
        .ok()
        .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse().ok())
        .unwrap_or(0.0);

    // Candidate seek points (10%, 50%, 90%) so a representative non-black
    // frame is found even for videos with long black leads.
    let probes: Vec<f64> = if duration > 0.0 {
        vec![duration * 0.1, duration * 0.5, duration * 0.9]
    } else {
        vec![1.0]
    };

    let mut done = false;
    for seek in probes {
        let seek_str = format!("{:.2}", seek);
        let arg_list: Vec<String> = [
            "-ss",
            seek_str.as_str(),
            "-i",
            path,
            "-vframes",
            "1",
            "-vf",
            "scale=640:-1",
            "-q:v",
            "5",
            thumb_path.as_str(),
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        if !run_ffmpeg(&arg_list).await || tokio::fs::metadata(&thumb_path).await.is_err() {
            continue; // this probe did not produce a frame
        }
        if !is_image_black(&thumb_path).await {
            done = true;
            break;
        }
        let _ = tokio::fs::remove_file(&thumb_path).await;
    }

    // Fall back to frame 0 so corrupted/very short streams still get a thumb.
    if !done && tokio::fs::metadata(&thumb_path).await.is_err() {
        let fallback: Vec<String> = [
            "-i",
            path,
            "-vframes",
            "1",
            "-vf",
            "scale=640:-1",
            "-q:v",
            "5",
            thumb_path.as_str(),
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let _ = run_ffmpeg(&fallback).await;
    }
}

/// True when the image's mean luma (YAVG) is below ~8/255, i.e. it is
/// effectively all black. Returns false if it cannot be measured.
async fn is_image_black(path: &str) -> bool {
    let out = tokio::process::Command::new("ffmpeg")
        .args([
            "-i",
            path,
            "-vf",
            "signalstats,metadata=print",
            "-f",
            "null",
            "-",
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .output()
        .await
        .ok();
    let Some(out) = out else { return false };
    let stderr = String::from_utf8_lossy(&out.stderr);
    for line in stderr.lines() {
        if let Some(start) = line.find("YAVG=") {
            let value: f64 = match line[start + 5..].trim().parse() {
                Ok(v) => v,
                Err(_) => return false,
            };
            return value < 8.0;
        }
    }
    false
}

/// Subtitle streams extracted from a video, in decode order.
#[derive(Debug)]
struct SubtitleStream {
    index: usize,
    codec: String,
    language: String,
    title: String,
}

/// List text-based subtitle streams of a video (ordinal subtitle index,
/// codec, language, title). `index` is 0-based *within subtitle streams*
/// (matching ffmpeg's `-map 0:s:N` selector), NOT the global ffprobe
/// stream position — using the global position here previously made
/// extraction fail for any file with audio/video streams before the subs.
///
/// The ordinal counts EVERY subtitle stream, including bitmap ones (PGS,
/// dvd_subtitle) that cannot become WebVTT. Counting only the text streams
/// shifts the ordinal whenever a bitmap track comes first — the common
/// layout in Blu-ray rips — so `-map 0:s:N` then extracts the wrong stream,
/// or fails outright and leaves the video with no captions at all.
async fn probe_subtitles(video: &str) -> Vec<SubtitleStream> {
    let Ok(output) = tokio::process::Command::new("ffprobe")
        .args(["-v", "error", "-show_streams", "-of", "json", video])
        .output()
        .await
    else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_slice::<Value>(&output.stdout) else {
        return Vec::new();
    };
    let Some(streams) = value.get("streams").and_then(|s| s.as_array()) else {
        return Vec::new();
    };
    let mut result: Vec<SubtitleStream> = Vec::new();
    let mut subtitle_ordinal = 0usize;
    for s in streams {
        if s.get("codec_type").and_then(|t| t.as_str()) != Some("subtitle") {
            continue;
        }
        let ordinal = subtitle_ordinal;
        subtitle_ordinal += 1;
        let codec = s
            .get("codec_name")
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .to_string();
        if !is_text_subtitle_codec(&codec) {
            continue;
        }
        let tags = s.get("tags").cloned().unwrap_or(Value::Null);
        result.push(SubtitleStream {
            index: ordinal,
            codec,
            language: tags
                .get("language")
                .and_then(|l| l.as_str())
                .unwrap_or("")
                .to_string(),
            title: tags
                .get("title")
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .to_string(),
        });
    }
    result
}

#[derive(Debug, serde::Serialize)]
struct SubtitleTrack {
    src: String,
    label: String,
    #[serde(rename = "language")]
    language: String,
}

/// `position` is the track's 0-based place in the offered caption list, used
/// only for the fallback label — never the stream ordinal, which can skip
/// numbers when bitmap subtitle streams are interleaved.
fn track_label(position: usize, language: &str, title: &str) -> String {
    if !title.is_empty() {
        return title.to_string();
    }
    // "und" is ffmpeg's placeholder for an untagged stream — showing it in the
    // caption menu is worse than a plain track number.
    if !language.is_empty() && language != "und" {
        return language.to_string();
    }
    format!("Track {}", position + 1)
}

/// Extract embedded text-based subtitle tracks from a video into sidecar
/// WebVTT files (`{video}@{i}.vtt`) plus a `{video}@subs.json` manifest so the
/// frontend can offer a selectable caption list. The `@subs` / `@N` suffix
/// convention (mirroring `.thumb.jpg` / `.preview.webp`) is a stable suffix
/// even when filenames contain spaces or extra dots. No-op when the manifest
/// already exists or the file has no extractable subtitle streams.
async fn extract_subtitles(video: &str) {
    let manifest_path = format!("{}@subs.json", video);
    if tokio::fs::metadata(&manifest_path).await.is_ok() {
        return;
    }

    let streams = probe_subtitles(video).await;
    if streams.is_empty() {
        return;
    }

    let mut tracks: Vec<SubtitleTrack> = Vec::new();
    for (position, stream) in streams.iter().enumerate() {
        let vtt_path = format!("{}@{}.vtt", video, stream.index);
        if tokio::fs::metadata(&vtt_path).await.is_err() {
            let mut command = tokio::process::Command::new("ffmpeg");
            command
                .arg("-y")
                .arg("-i")
                .arg(video)
                .arg("-map")
                .arg(format!("0:s:{}", stream.index))
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null());
            // Re-mux ASS to WebVTT (the webvtt muxer handles srt / mov_text /
            // webvtt natively via the `-f webvtt` format).
            if stream.codec == "ass" || stream.codec == "ssa" {
                command.args(["-c:s", "webvtt"]);
            } else {
                command.args(["-f", "webvtt"]);
            }
            command.arg(&vtt_path);
            if !command.status().await.map(|s| s.success()).unwrap_or(false)
                || tokio::fs::metadata(&vtt_path).await.is_err()
            {
                let _ = tokio::fs::remove_file(&vtt_path).await;
                continue;
            }
        }
        tracks.push(SubtitleTrack {
            src: format!("@{}.vtt", stream.index),
            label: track_label(position, &stream.language, &stream.title),
            language: stream.language.clone(),
        });
    }

    if tracks.is_empty() {
        return;
    }
    let manifest = json!({ "tracks": tracks });
    if let Ok(text) = serde_json::to_string(&manifest) {
        let _ = tokio::fs::write(&manifest_path, text).await;
    }
}

/// Width of thumbnails generated by the current version of
/// `generate_thumbnail`. Thumbnails narrower than this were produced by an
/// older (frame-0) generator and must be treated as stale.
const THUMB_TARGET_WIDTH: u32 = 640;

/// True when a video has no thumbnail, or its thumbnail was produced by a
/// legacy (stale) version and should be regenerated.
async fn thumb_needs_update(video: &str) -> bool {
    let thumb = format!("{}.thumb.jpg", video);
    if tokio::fs::metadata(&thumb).await.is_err() {
        return true;
    }
    let width: u32 = tokio::process::Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            &thumb,
        ])
        .output()
        .await
        .ok()
        .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse().ok())
        .unwrap_or(0);
    width < THUMB_TARGET_WIDTH
}

/// Startup migration: regenerate existing video thumbnails that were produced
/// by a legacy generator (narrower than THUMB_TARGET_WIDTH — the old frame-0
/// captures that render all black).
/// Idempotent — healthy (newer-generation) thumbnails are left untouched, and
/// a regenerated thumbnail meets the width target, so it is never
/// re-processed on restart.
pub(crate) async fn fix_black_thumbnails() {
    let root = "external";
    let mut stack = vec![std::path::PathBuf::from(root)];
    let mut fixed = 0u32;

    while let Some(dir) = stack.pop() {
        let mut rd = match tokio::fs::read_dir(&dir).await {
            Ok(rd) => rd,
            Err(_) => continue,
        };
        let mut entries = Vec::new();
        while let Ok(Some(entry)) = rd.next_entry().await {
            entries.push(entry);
        }
        for entry in entries {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.ends_with(".thumb.jpg") {
                continue;
            }
            let thumb_path = path.to_string_lossy().to_string();
            let video = path
                .with_file_name(name.trim_end_matches(".thumb.jpg"))
                .to_string_lossy()
                .to_string();
            if tokio::fs::metadata(&video).await.is_err() {
                continue; // orphan thumbnail; nothing to regenerate
            }
            if !thumb_needs_update(&video).await && !is_image_black(&thumb_path).await {
                continue;
            }
            let _ = tokio::fs::remove_file(&thumb_path).await;
            generate_thumbnail(&video).await;
            fixed += 1;
        }
    }

    if fixed > 0 {
        println!("Fixed {fixed} black video thumbnail(s) at startup");
    }
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
            "-y",
            "-i",
            path,
            "-vframes",
            "1",
            "-vf",
            "scale=1024:1024:force_original_aspect_ratio=decrease",
            "-quality",
            "80",
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
    let ext_lower = filename
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
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
            return error_response(
                StatusCode::BAD_REQUEST,
                "File does not appear to be a valid font",
            );
        }
    }

    let upload_limit = state.server_settings.read().await.upload_limit_bytes;
    if upload_limit > 0 && data.len() as u64 > upload_limit {
        return error_response(
            StatusCode::BAD_REQUEST,
            &format!("File too large (max {})", format_bytes_short(upload_limit)),
        );
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
    let vid_ext = filename
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    if matches!(vid_ext.as_str(), "mp4" | "mov" | "m4v" | "webm" | "ogg") {
        generate_thumbnail(&path).await;
        extract_subtitles(&path).await;
    }

    // Generate a downscaled WebP preview for still images
    let img_ext = filename
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
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
        return error_response(
            StatusCode::BAD_REQUEST,
            &format!("File too large (max {})", format_bytes_short(upload_limit)),
        );
    }

    if let Err(e) = check_storage_quota(&state, &user_id, body.file_size).await {
        return e;
    }

    let filename = body.filename.replace(['/', '\\', '\0'], "_");
    if filename.is_empty() {
        return error_response(StatusCode::BAD_REQUEST, "No filename provided");
    }

    let chunk_count = body.file_size.div_ceil(CHUNK_SIZE as u64);

    // Generate upload ID
    use rand::Rng;
    let bytes: [u8; 16] = rand::thread_rng().gen();
    let upload_id: String = bytes.iter().map(|b| format!("{:02x}", b)).collect();

    let chunk_dir = format!("external/.chunks/{}", upload_id);
    if tokio::fs::create_dir_all(&chunk_dir).await.is_err() {
        return error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to create chunk dir",
        );
    }

    // Write metadata sidecar
    let meta = ChunkMeta {
        filename,
        file_size: body.file_size,
        user_id,
        chunk_count,
    };
    let meta_path = format!("{}/meta.json", chunk_dir);
    if tokio::fs::write(&meta_path, serde_json::to_string(&meta).unwrap())
        .await
        .is_err()
    {
        return error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to write metadata",
        );
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
            "file" => match field.bytes().await {
                Ok(b) => chunk_data = Some(b),
                Err(_) => return error_response(StatusCode::BAD_REQUEST, "Failed to read chunk"),
            },
            _ => {}
        }
    }

    if upload_id.is_empty()
        || upload_id.len() != 32
        || !upload_id.chars().all(|c| c.is_ascii_hexdigit())
    {
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
    if upload_id.is_empty()
        || upload_id.len() != 32
        || !upload_id.chars().all(|c| c.is_ascii_hexdigit())
    {
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
        return error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to create directory",
        );
    }

    let filename = &meta.filename;
    let path = format!("{}/{}", dir, filename);

    // Concatenate chunks into final file
    let mut file = match tokio::fs::File::create(&path).await {
        Ok(f) => f,
        Err(_) => {
            return error_response(StatusCode::INTERNAL_SERVER_ERROR, "Failed to create file")
        }
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
    let vid_ext = filename
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    if matches!(vid_ext.as_str(), "mp4" | "mov" | "m4v" | "webm" | "ogg") {
        generate_thumbnail(&path).await;
        extract_subtitles(&path).await;
    }

    // Generate a downscaled WebP preview for still images
    let img_ext = filename
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
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
            || v4.octets()[0] == 198 && (v4.octets()[1] == 18 || v4.octets()[1] == 19)
            // 198.18/15 (benchmark)
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
    result = numeric_re
        .replace_all(&result, |caps: &regex::Captures| {
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
        })
        .to_string();

    result
}

/// Extract the <head> section from HTML to limit meta tag search scope.
/// Uses a regex to avoid byte-offset mismatches from case-folding multi-byte chars.
fn extract_head_section(html: &str) -> &str {
    // Clamp scan to 128KB
    let haystack = if html.len() > 128 * 1024 {
        &html[..128 * 1024]
    } else {
        html
    };
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

    let val = caps
        .get(1)
        .or_else(|| caps.get(2))
        .or_else(|| caps.get(3))
        .map(|m| m.as_str().trim().to_string())?;

    if val.is_empty() {
        return None;
    }
    Some(decode_html_entities(&val))
}

/// Find all <meta ...> tags in the HTML head section (case-insensitive).
/// Uses regex to properly handle multi-line tags and multi-byte chars.
fn find_meta_tags(html: &str) -> Vec<String> {
    let head = extract_head_section(html);
    let meta_re = regex::Regex::new(r"(?is)<meta\s[^>]*>").unwrap();
    meta_re
        .find_iter(head)
        .map(|m| m.as_str().to_string())
        .collect()
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
    if title.is_empty() {
        return None;
    }
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
                        let cs = lower[pos + 8..]
                            .split(';')
                            .next()
                            .unwrap_or("")
                            .trim()
                            .to_string();
                        if !cs.is_empty() {
                            return Some(cs);
                        }
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
            let scheme = if base.starts_with("https") {
                "https:"
            } else {
                "http:"
            };
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
fn build_pinned_client(
    url: &str,
    validated_addrs: &[SocketAddr],
) -> Result<reqwest::Client, String> {
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
                        description: json["html"].as_str().map(|h| {
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
                        return (
                            StatusCode::OK,
                            Json(
                                serde_json::to_value(&CachedPreview {
                                    title: None,
                                    description: None,
                                    image: None,
                                    site_name: None,
                                })
                                .unwrap(),
                            ),
                        );
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
            return (
                StatusCode::OK,
                Json(
                    serde_json::to_value(&CachedPreview {
                        title: None,
                        description: None,
                        image: None,
                        site_name: None,
                    })
                    .unwrap(),
                ),
            );
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
            || matches!(
                html_charset.as_deref(),
                Some("iso-8859-1" | "latin1" | "latin-1" | "windows-1252")
            );

        let body = if is_latin {
            // Decode as Latin-1 (each byte maps directly to a Unicode code point)
            bytes_to_parse
                .iter()
                .map(|&b| b as char)
                .collect::<String>()
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
                url::Url::parse(&url).ok().and_then(|u| {
                    u.host_str().map(|h| {
                        // Strip www. prefix
                        h.strip_prefix("www.").unwrap_or(h).to_string()
                    })
                })
            });

        CachedPreview {
            title,
            description,
            image,
            site_name,
        }
    };

    // Only cache if there's actual content — don't cache empty results forever
    let has_content =
        preview.title.is_some() || preview.description.is_some() || preview.image.is_some();

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
        "html"
            | "htm"
            | "xhtml"
            | "js"
            | "mjs"
            | "cjs"
            | "ts"
            | "css"
            | "svg"
            | "xml"
            | "xsl"
            | "xslt"
            | "wasm"
            | "crx"
            | "swf"
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

/// Map a request URI path under `/external` to its path on disk.
///
/// The URI is percent-encoded (uploads keep spaces and other literal
/// characters in their filenames), so the raw path must be decoded before it
/// can be opened — ServeDir does this for the files it serves, but every
/// branch below reads from disk directly. Returns `None` when the decoded
/// path escapes the `external/` root.
fn external_disk_path(uri_path: &str) -> Option<String> {
    let relative = uri_path.trim_start_matches('/');
    let decoded = percent_encoding::percent_decode_str(relative)
        .decode_utf8()
        .ok()?
        .into_owned();
    if decoded
        .split(['/', '\\'])
        .any(|segment| segment == ".." || segment == ".")
    {
        return None;
    }
    Some(format!("external/{decoded}"))
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
        let Some(disk_path) = external_disk_path(&uri_path) else {
            return Response::builder()
                .status(StatusCode::NOT_FOUND)
                .body(Body::from("Not found"))
                .unwrap();
        };
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

    // Generate (or regenerate stale/black) thumbnail on demand when the
    // .thumb.jpg is requested
    if uri_path.ends_with(".thumb.jpg") {
        if let Some(thumb_disk) = external_disk_path(&uri_path) {
            let video_disk = thumb_disk.strip_suffix(".thumb.jpg").unwrap_or(&thumb_disk);
            if thumb_needs_update(video_disk).await {
                let _ = tokio::fs::remove_file(&thumb_disk).await;
                generate_thumbnail(video_disk).await;
            }
        }
    }

    // Serve subtitle manifests and tracks with explicit, correct
    // Content-Types — the `@token` suffix can make some servers guess a
    // text/* content-type that would break `<track>` loading or JSON parsing.
    if uri_path.ends_with("@subs.json") || uri_path.ends_with(".vtt") {
        let Some(disk_path) = external_disk_path(&uri_path) else {
            return Response::builder()
                .status(StatusCode::NOT_FOUND)
                .body(Body::from("Not found"))
                .unwrap();
        };
        let content_type = if uri_path.ends_with("@subs.json") {
            "application/json"
        } else {
            "text/vtt"
        };
        // Extract on demand when the sidecars aren't there yet. The player
        // requests the manifest as soon as it mounts, in parallel with the
        // video itself, so waiting for the video request below to do the
        // extraction loses the race and the player concludes the video has no
        // captions. This also covers videos uploaded before CC existed.
        if tokio::fs::metadata(&disk_path).await.is_err() {
            if let Some(video) = disk_path
                .strip_suffix("@subs.json")
                .or_else(|| disk_path.rsplit_once('@').map(|(base, _)| base))
            {
                if tokio::fs::metadata(video).await.is_ok() {
                    extract_subtitles(video).await;
                }
            }
        }
        match tokio::fs::read(&disk_path).await {
            Ok(data) => {
                return Response::builder()
                    .status(StatusCode::OK)
                    .header(header::CONTENT_TYPE, content_type)
                    .body(Body::from(data))
                    .unwrap();
            }
            Err(_) => {
                return Response::builder()
                    .status(StatusCode::NOT_FOUND)
                    .body(Body::from("Not found"))
                    .unwrap();
            }
        }
    }

    // Generate a WebP preview on demand when the .preview.webp is requested
    if uri_path.ends_with(".preview.webp") {
        let preview_disk = external_disk_path(&uri_path).unwrap_or_default();
        if !preview_disk.is_empty() && tokio::fs::metadata(&preview_disk).await.is_err() {
            let source_disk = preview_disk
                .strip_suffix(".preview.webp")
                .unwrap_or(&preview_disk);
            generate_image_preview(source_disk).await;
        }
    }

    // For MP4/MOV files, apply faststart on first access so the moov atom
    // is at the front of the file — required for instant seeking in browsers.
    // Also generate a thumbnail if one doesn't exist yet.
    if matches!(ext.as_str(), "mp4" | "mov" | "m4v" | "webm" | "ogg") {
        let disk_path = external_disk_path(&uri_path).unwrap_or_default();

        if !disk_path.is_empty() && matches!(ext.as_str(), "mp4" | "mov" | "m4v") {
            let marker = format!("{}.faststarted", disk_path);
            if tokio::fs::metadata(&marker).await.is_err()
                && tokio::fs::metadata(&disk_path).await.is_ok()
            {
                let tmp = format!("{}.faststart.tmp", disk_path);
                let result = tokio::process::Command::new("ffmpeg")
                    .args([
                        "-y",
                        "-i",
                        &disk_path,
                        "-c",
                        "copy",
                        "-movflags",
                        "+faststart",
                        &tmp,
                    ])
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

        // Lazily generate thumbnail + subtitle sidecars for existing videos
        if !disk_path.is_empty() {
            generate_thumbnail(&disk_path).await;
            extract_subtitles(&disk_path).await;
        }
    }

    // For non-browser video formats, convert to MP4 on first access
    // (preserving subtitle streams as mov_text) then rewrite the request URI
    // so ServeDir serves the MP4. Subtitle sidecars and the manifest are keyed
    // to the ORIGINAL filename (what the client holds in its URL), stored next
    // to the source file.
    if matches!(ext.as_str(), "mkv" | "avi" | "wmv" | "flv" | "ts") {
        let disk_path = external_disk_path(&uri_path).unwrap_or_default();
        let base = uri_path
            .rsplit_once('.')
            .map(|(b, _)| b)
            .unwrap_or(&uri_path);
        let mp4_uri = format!("{}.mp4", base);
        let mp4_disk = external_disk_path(&mp4_uri).unwrap_or_default();
        if disk_path.is_empty() || mp4_disk.is_empty() {
            return next.run(req).await.into_response();
        }

        // Extract subtitle sidecars + manifest keyed to the ORIGINAL video.
        if tokio::fs::metadata(&disk_path).await.is_ok() {
            extract_subtitles(&disk_path).await;
        }

        // Convert if the cached MP4 doesn't exist yet
        if tokio::fs::metadata(&mp4_disk).await.is_err()
            && tokio::fs::metadata(&disk_path).await.is_ok()
        {
            if let Some(tmp_path) = remux_with_subs(&disk_path).await {
                let _ = tokio::fs::rename(&tmp_path, &mp4_disk).await;
            }
        }

        // Lazily generate a thumbnail for the served MP4, then rewrite the
        // request to serve it
        if tokio::fs::metadata(&mp4_disk).await.is_ok() {
            generate_thumbnail(&mp4_disk).await;
            let (mut parts, body) = req.into_parts();
            parts.uri = mp4_uri.parse().unwrap_or(parts.uri);
            let req = axum::http::Request::from_parts(parts, body);
            return next.run(req).await.into_response();
        }
    }

    // Pass through to ServeDir
    next.run(req).await.into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a test video (video + audio) with a mov_text subtitle track so
    /// that the subtitle stream has a GLOBAL index of 2, the case that broke
    /// the old `-map 0:s:{global_index}` extraction path.
    async fn build_fixture() -> (String, String) {
        let dir = std::env::temp_dir().join(format!("chatter_cc_test_{}", std::process::id()));
        let _ = tokio::fs::create_dir_all(&dir).await;
        let video = dir.join("fixture.mp4").to_string_lossy().to_string();
        let vtt = dir.join("fixture_src.vtt").to_string_lossy().to_string();
        // Drop sidecars from any earlier run so the test is deterministic.
        for suffix in ["@subs.json", "@0.vtt", "@1.vtt", "@2.vtt"] {
            let _ = tokio::fs::remove_file(format!("{}{}", video, suffix)).await;
        }
        tokio::fs::write(
            &vtt,
            "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello world\n",
        )
        .await
        .unwrap();
        let status = tokio::process::Command::new("ffmpeg")
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc=duration=5:size=320x240:rate=10",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=5",
                "-i",
                &vtt,
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-c:a",
                "aac",
                "-c:s",
                "mov_text",
                "-shortest",
                &video,
            ])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .await
            .expect("ffmpeg should be available");
        assert!(status.success(), "fixture build failed");
        (video.clone(), format!("{}@subs.json", video))
    }

    #[tokio::test]
    async fn subtitle_extraction_uses_ordinal_subtitle_index() {
        let (video, manifest) = build_fixture().await;

        // Regression: the subtitle stream is global index 2 (video=0, audio=1).
        // probe_subtitles must report ordinal 0; the old code reported 2, which
        // made `-map 0:s:2` fail and no sidecars/manifest were produced.
        let streams = probe_subtitles(&video).await;
        assert_eq!(streams.len(), 1);
        assert_eq!(streams[0].index, 0);
        assert_eq!(streams[0].codec, "mov_text");

        extract_subtitles(&video).await;

        let vtt_path = format!("{}@0.vtt", video);
        let data = tokio::fs::read(&vtt_path)
            .await
            .expect("vtt sidecar not created");
        let text = String::from_utf8(data).unwrap();
        assert!(text.contains("Hello world"));

        let manifest_data = tokio::fs::read(&manifest)
            .await
            .expect("subs manifest not created");
        let value: Value = serde_json::from_slice(&manifest_data).unwrap();
        let tracks = value["tracks"]
            .as_array()
            .expect("manifest should list tracks");
        assert_eq!(tracks.len(), 1);
        assert_eq!(tracks[0]["src"], "@0.vtt");

        // Cleanup
        for p in [&video, &vtt_path, &manifest] {
            let _ = tokio::fs::remove_file(p).await;
        }
    }

    /// Build a video whose FIRST subtitle stream is one this extractor cannot
    /// turn into WebVTT (ttml here; a Blu-ray rip's PGS stream in the wild),
    /// followed by an extractable mov_text track carrying distinct text.
    async fn build_mixed_fixture() -> (String, String) {
        let dir = std::env::temp_dir().join(format!("chatter_cc_mixed_{}", std::process::id()));
        let _ = tokio::fs::create_dir_all(&dir).await;
        let video = dir.join("mixed.mp4").to_string_lossy().to_string();
        let first = dir.join("first.vtt").to_string_lossy().to_string();
        let second = dir.join("second.vtt").to_string_lossy().to_string();
        for suffix in ["@subs.json", "@0.vtt", "@1.vtt"] {
            let _ = tokio::fs::remove_file(format!("{}{}", video, suffix)).await;
        }
        tokio::fs::write(
            &first,
            "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nFIRST STREAM\n",
        )
        .await
        .unwrap();
        tokio::fs::write(
            &second,
            "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nSECOND STREAM\n",
        )
        .await
        .unwrap();
        let status = tokio::process::Command::new("ffmpeg")
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc=duration=5:size=320x240:rate=10",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=5",
                "-i",
                &first,
                "-i",
                &second,
                "-map",
                "0:v",
                "-map",
                "1:a",
                "-map",
                "2:s",
                "-map",
                "3:s",
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-c:a",
                "aac",
                "-c:s:0",
                "ttml",
                "-c:s:1",
                "mov_text",
                "-shortest",
                &video,
            ])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .await
            .expect("ffmpeg should be available");
        assert!(status.success(), "mixed fixture build failed");
        (video.clone(), format!("{}@subs.json", video))
    }

    #[tokio::test]
    async fn subtitle_ordinal_counts_non_text_streams() {
        let (video, manifest) = build_mixed_fixture().await;

        // Regression: the extractable track is subtitle stream 1, behind a
        // stream this code skips. Numbering only the text streams reported 0,
        // so `-map 0:s:0` hit the unusable stream — ffmpeg failed, the track
        // was dropped, no manifest was written, and the player reported that
        // the video had no captions at all.
        let streams = probe_subtitles(&video).await;
        assert_eq!(streams.len(), 1, "only the mov_text stream is extractable");
        assert_eq!(streams[0].index, 1, "ordinal must count the skipped stream");

        extract_subtitles(&video).await;

        let vtt_path = format!("{}@1.vtt", video);
        let text = String::from_utf8(
            tokio::fs::read(&vtt_path)
                .await
                .expect("vtt sidecar not created"),
        )
        .unwrap();
        assert!(
            text.contains("SECOND STREAM"),
            "extracted the wrong stream: {text}"
        );

        let manifest_data = tokio::fs::read(&manifest)
            .await
            .expect("subs manifest not created");
        let value: Value = serde_json::from_slice(&manifest_data).unwrap();
        let tracks = value["tracks"]
            .as_array()
            .expect("manifest should list tracks");
        assert_eq!(tracks.len(), 1);
        assert_eq!(tracks[0]["src"], "@1.vtt");
        // Fallback label numbers from the offered list, not the stream ordinal.
        assert_eq!(tracks[0]["label"], "Track 1");

        for p in [&video, &vtt_path, &manifest] {
            let _ = tokio::fs::remove_file(p).await;
        }
    }

    #[test]
    fn external_disk_path_decodes_and_blocks_traversal() {
        // Uploads keep spaces in their filenames; the URI is percent-encoded,
        // so an undecoded path opened the wrong (non-existent) file and every
        // sidecar 404'd for any video with a space in its name.
        assert_eq!(
            external_disk_path("/uploads/u1/My%20Movie.mkv@subs.json").as_deref(),
            Some("external/uploads/u1/My Movie.mkv@subs.json"),
        );
        assert_eq!(
            external_disk_path("/uploads/u1/plain.mp4").as_deref(),
            Some("external/uploads/u1/plain.mp4"),
        );
        assert_eq!(external_disk_path("/uploads/../../etc/passwd"), None);
        assert_eq!(
            external_disk_path("/uploads/%2e%2e/%2e%2e/etc/passwd"),
            None
        );
    }
}
