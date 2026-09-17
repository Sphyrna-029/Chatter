use super::super::{
    constants::CHUNK_SIZE,
    dto::{GifSearchQuery, LinkPreviewQuery},
    helpers::{error_response, extract_token, get_user_from_token, rate_limited},
    metrics, ratelimit,
    state::{AppState, CachedPreview, UploadRecord},
};
use axum::{
    body::Body,
    extract::{Multipart, Path as AxumPath, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Json, Response},
};
use futures_util::TryStreamExt;
use mongodb::bson::doc;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::sync::{Arc, LazyLock};

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

    // Plus whatever this person already has in flight. Bytes in a staging dir
    // are not a record yet, so ten uploads started together each saw the same
    // free space and all of them passed — a limit that only counts what has
    // finished cannot hold while anything is arriving.
    current_total += staging_bytes_for(Some(user_id)).await;

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
            // The remux already wrote the moov atom up front, so the MP4 does
            // not need a faststart pass the first time it is played.
            let _ = tokio::fs::write(format!("{}.faststarted", new_path), b"").await;
            let new_filename = new_filename_from_path(&new_path);
            return (new_path, new_filename);
        }
        // Conversion failed — clean up and keep original
        let _ = tokio::fs::remove_file(&format!("{}.cc.tmp", path)).await;
        return (path.to_string(), filename.to_string());
    }

    // For MP4/MOV, apply faststart
    if matches!(ext.as_str(), "mp4" | "mov" | "m4v") {
        faststart_in_place(path, &ext).await;
    }

    (path.to_string(), filename.to_string())
}

/// Serializes the in-place ffmpeg passes (faststart, MKV→MP4) per file. A
/// `<video>` element opens a source with several parallel range requests;
/// without this each would start its own ffmpeg writing the same temp path,
/// and the first to finish would rename a half-written file into place.
static MEDIA_JOBS: LazyLock<tokio::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    LazyLock::new(|| tokio::sync::Mutex::new(HashMap::new()));

async fn media_job_lock(path: &str) -> Arc<tokio::sync::Mutex<()>> {
    MEDIA_JOBS
        .lock()
        .await
        .entry(path.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

/// Move the moov atom to the front of an MP4/MOV so the browser can start
/// playing (and seek) before the whole file has arrived. Rewrites the file in
/// place; on failure the original is left untouched.
///
/// The temp output ends in `.tmp`, an extension ffmpeg cannot map to a muxer,
/// so the container has to be named explicitly with `-f`.
///
/// Runs at most once per file: the `.faststarted` marker is written whether or
/// not ffmpeg succeeded, so a file it cannot process is not retried on every
/// request.
async fn faststart_in_place(path: &str, ext: &str) -> bool {
    let job = media_job_lock(path).await;
    let _guard = job.lock().await;

    let marker = format!("{}.faststarted", path);
    if tokio::fs::metadata(&marker).await.is_ok() {
        return true; // another request already ran the pass
    }

    let _job = metrics::media_job();
    let format = if ext == "mov" { "mov" } else { "mp4" };
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
            "-f",
            format,
            &tmp,
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .await;
    let ok = matches!(result, Ok(status) if status.success())
        && tokio::fs::rename(&tmp, path).await.is_ok();
    let _ = tokio::fs::remove_file(&tmp).await;
    let _ = tokio::fs::write(&marker, b"").await;
    ok
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
/// Which kinds of stream a file actually has.
async fn stream_kinds(path: &str) -> Vec<String> {
    let Ok(output) = tokio::process::Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            path,
        ])
        .output()
        .await
    else {
        return Vec::new();
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .collect()
}

async fn has_audio(path: &str) -> bool {
    stream_kinds(path).await.iter().any(|kind| kind == "audio")
}

/// One conversion attempt. `Err` carries the tail of ffmpeg's complaint, which
/// used to go to `/dev/null` — so a conversion that failed left no trace
/// anywhere and the only symptom was a video that behaved oddly days later.
async fn try_remux(src: &str, dst: &str, args: &[String]) -> Result<(), String> {
    let _ = tokio::fs::remove_file(dst).await;
    let mut command = tokio::process::Command::new("ffmpeg");
    command.args(["-y", "-i", src]);
    command.args(args);
    command.args([
        "-movflags",
        "+faststart",
        // The destination ends in `.tmp`, which ffmpeg cannot map to a muxer,
        // so the container has to be named explicitly.
        "-f",
        "mp4",
        dst,
    ]);
    let output = command
        .stdout(std::process::Stdio::null())
        .output()
        .await
        .map_err(|e| format!("could not run ffmpeg: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail: Vec<&str> = stderr.lines().rev().take(4).collect();
        return Err(tail.into_iter().rev().collect::<Vec<_>>().join(" / "));
    }
    if tokio::fs::metadata(dst).await.is_err() {
        return Err("ffmpeg reported success but wrote nothing".to_string());
    }
    Ok(())
}

fn owned(args: &[&str]) -> Vec<String> {
    args.iter().map(|a| a.to_string()).collect()
}

/// Convert a container browsers will not play into an MP4 they will.
///
/// A ladder rather than one command, because one command is all or nothing:
/// anything ffmpeg refuses — a bitmap subtitle track `mov_text` cannot take, a
/// video codec MP4 will not hold — failed the whole conversion, and the upload
/// then kept the original. The person was handed a Matroska file, and what a
/// browser makes of one varies by codec: often it renders the video, finds an
/// audio codec it cannot decode, and greys the track selector out. A video
/// that plays silently, with nothing anywhere saying why.
///
/// Each rung gives up something to get past whatever stopped the one above.
/// Audio is never what is given up, and the result is checked rather than
/// assumed: a conversion that exits cleanly having quietly dropped the audio
/// is the same failure as one that refused outright, so it is treated as one.
async fn remux_with_subs(src: &str) -> Option<String> {
    let _job = metrics::media_job();
    let dst = format!("{}.cc.tmp", src);
    let source_had_audio = has_audio(src).await;

    // Only text subtitles can become `mov_text`. Mapping them by ordinal keeps
    // the ones that can travel when a bitmap track in the same file would
    // otherwise sink every subtitle in it.
    // `index` is the stream's own position among the subtitle streams, not its
    // position in this filtered list — a file whose only text track is the
    // second of three would otherwise be mapped by the first, which is the
    // bitmap one that stopped the rung above.
    let text_subs: Vec<String> = probe_subtitles(src)
        .await
        .iter()
        .map(|stream| format!("0:s:{}", stream.index))
        .collect();
    let mut text_only = owned(&["-map", "0:v:0", "-map", "0:a?"]);
    for stream in &text_subs {
        text_only.push("-map".to_string());
        text_only.push(stream.clone());
    }
    text_only.extend(owned(&["-c:v", "copy", "-c:a", "aac", "-ac", "2"]));
    if !text_subs.is_empty() {
        text_only.extend(owned(&["-c:s", "mov_text"]));
    }

    let ladder: Vec<(&str, Vec<String>)> = vec![
        (
            "copying the video, every subtitle",
            owned(&[
                "-map", "0:v:0", "-map", "0:a?", "-map", "0:s?", "-c:v", "copy", "-c:a", "aac",
                "-ac", "2", "-c:s", "mov_text",
            ]),
        ),
        ("copying the video, text subtitles only", text_only),
        (
            "re-encoding the video, no subtitles",
            owned(&[
                "-map", "0:v:0", "-map", "0:a?", "-c:v", "libx264", "-preset", "veryfast", "-crf",
                "23", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "2",
            ]),
        ),
    ];

    for (rung, (what, args)) in ladder.iter().enumerate() {
        match try_remux(src, &dst, args).await {
            Ok(()) => {
                if source_had_audio && !has_audio(&dst).await {
                    eprintln!("[media] {src}: {what} lost the audio");
                    let _ = tokio::fs::remove_file(&dst).await;
                    continue;
                }
                if rung > 0 {
                    eprintln!("[media] {src}: converted by {what}");
                }
                return Some(dst);
            }
            Err(why) => {
                eprintln!("[media] {src}: {what} failed: {why}");
                let _ = tokio::fs::remove_file(&dst).await;
            }
        }
    }

    eprintln!("[media] {src}: could not be converted to MP4");
    None
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
    let _job = metrics::media_job();

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
    let _job = metrics::media_job();

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

/// Remove a thumbnail and anything derived from it.
///
/// The `.preview.webp` beside it is a copy of the picture being replaced, and
/// a preview is only ever generated when it is missing — left behind, it goes
/// on being served in place of the thumbnail that replaced it.
async fn remove_thumbnail(thumb_path: &str) {
    let _ = tokio::fs::remove_file(thumb_path).await;
    let _ = tokio::fs::remove_file(format!("{thumb_path}.preview.webp")).await;
}

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

/// Startup migration: give every upload the folder it has always lived in.
///
/// `folder` is what identifies an upload now that one file can be named by
/// several URLs — and it is the only field the format conversions cannot move.
/// Every record predating it still carries that folder inside its `disk_path`,
/// so there is nothing here to guess; without it a purge would pass over every
/// upload made before today.
pub(crate) async fn backfill_upload_folders(state: Arc<AppState>) {
    let uploads = state.db.collection::<UploadRecord>("uploads");
    let filter = doc! { "$or": [
        { "folder": { "$exists": false } },
        { "folder": "" },
    ] };
    let Ok(mut cursor) = uploads.find(filter).await else {
        return;
    };

    let mut records: Vec<UploadRecord> = Vec::new();
    while let Ok(Some(record)) = cursor.try_next().await {
        records.push(record);
    }

    let mut recorded = 0usize;
    for record in &records {
        // A record whose path does not follow the layout is left alone rather
        // than given a folder it does not have.
        let Some(folder) = upload_folder_path(&record.disk_path)
            .and_then(|dir| dir.file_name().and_then(|n| n.to_str()).map(String::from))
        else {
            continue;
        };
        if uploads
            .update_one(
                doc! { "url": &record.url },
                doc! { "$set": { "folder": &folder } },
            )
            .await
            .is_ok()
        {
            recorded += 1;
        }
    }
    if recorded > 0 {
        eprintln!("[uploads] recorded the folder for {recorded} older uploads");
    }
}

/// Startup migration: measure uploads whose dimensions were never recorded.
///
/// Without this the reflow only stops for media uploaded from here on, and the
/// timeline that actually moves under a reader is old history — which is all
/// of it. Runs once in the background, skips anything already measured, and
/// leaves a record alone if the file behind it has gone.
pub(crate) async fn backfill_image_dimensions(state: Arc<AppState>) {
    let uploads = state.db.collection::<UploadRecord>("uploads");
    // Records never measured, plus those a previous run marked with a zero.
    // The zeroes have to be revisited because that run recorded one for every
    // video: dimensions were an image concern until a tall video turned out to
    // lay its thumbnail out in a box the width of a wide one.
    let filter = doc! { "$or": [
        { "width": { "$exists": false } },
        { "width": 0 },
    ] };
    let mut cursor = match uploads.find(filter).await {
        Ok(c) => c,
        Err(_) => return,
    };

    let mut measured = 0u32;
    let mut records = Vec::new();
    while let Ok(Some(record)) = cursor.try_next().await {
        records.push(record);
    }
    for record in records {
        let ext = record
            .filename
            .rsplit('.')
            .next()
            .unwrap_or("")
            .to_ascii_lowercase();
        // Marked as measured either way, so a directory full of documents is
        // walked once rather than on every restart.
        let dims = if is_measurable_image(&ext) {
            // A zero already standing against an image is a probe that failed;
            // repeating it every boot would not make it succeed.
            match record.width {
                Some(_) => None,
                None => probe_image_dimensions(&record.disk_path).await,
            }
        } else if is_thumbnailed_video(&ext) {
            // Measured through the thumbnail, which may not exist yet: these
            // are generated on first view, and a video nobody has opened has
            // none. Generating it here is what the migration is for, and it
            // returns immediately when one is already there.
            generate_thumbnail(&record.disk_path).await;
            probe_video_dimensions(&record.disk_path).await
        } else {
            None
        };
        // Nothing learned and a zero already recorded: leave the record alone
        // rather than rewriting the same value on every restart.
        if dims.is_none() && record.width.is_some() {
            continue;
        }
        let (w, h) = match dims {
            Some((w, h)) => (w as i64, h as i64),
            None => (0, 0),
        };
        let updated = uploads
            .update_one(
                doc! { "url": &record.url },
                doc! { "$set": { "width": w, "height": h } },
            )
            .await;
        if updated.is_ok() && w > 0 {
            measured += 1;
        }
    }

    if measured > 0 {
        println!("Measured {measured} existing upload(s) at startup");
    }
}

/// Startup migration: regenerate existing video thumbnails that were produced
/// by a legacy generator (narrower than THUMB_TARGET_WIDTH — the old frame-0
/// captures that render all black).
///
/// Idempotent — healthy (newer-generation) thumbnails are left untouched, and
/// a regenerated thumbnail meets the width target, so it is never
/// re-processed on restart.
pub(crate) async fn fix_black_thumbnails(state: Arc<AppState>) {
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
            remove_thumbnail(&thumb_path).await;
            generate_thumbnail(&video).await;
            // The new capture is not necessarily the shape the old one was,
            // and the record still describes the old one.
            record_thumbnail_dimensions(&state, &video).await;
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
    let _job = metrics::media_job();
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

/// Pixel dimensions of a still image, read without decoding the whole file.
///
/// Recorded at upload so a message carrying the image can reserve its space
/// before a byte of it has arrived. Without that the row is laid out at no
/// height and jumps to full height when the image lands, which is what moves
/// the timeline under a reader scrolling through history.
///
/// Deliberately wider than `is_previewable_image`: a GIF gets no preview but
/// still has a size, and animated media is the worst offender for reflow.
pub(crate) async fn probe_image_dimensions(path: &str) -> Option<(u32, u32)> {
    let out = tokio::process::Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height",
            "-of",
            "csv=s=x:p=0",
            path,
        ])
        .output()
        .await
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().next()?.trim();
    let (w, h) = line.split_once('x')?;
    let w: u32 = w.trim().parse().ok()?;
    let h: u32 = h.trim().parse().ok()?;
    // A zero on either axis is ffprobe failing to read rather than a real
    // image, and storing it would reserve a box that can never be right.
    if w == 0 || h == 0 {
        return None;
    }
    Some((w, h))
}

/// Still-image extensions worth probing.
pub(crate) fn is_measurable_image(ext: &str) -> bool {
    matches!(
        ext,
        "jpg" | "jpeg" | "png" | "webp" | "bmp" | "tiff" | "gif" | "avif"
    )
}

/// Video formats a browser plays directly, and which therefore get a
/// `.thumb.jpg` sidecar rather than a transcode.
pub(crate) fn is_thumbnailed_video(ext: &str) -> bool {
    matches!(ext, "mp4" | "mov" | "m4v" | "webm" | "ogg")
}

/// The size a video will occupy in the timeline: its thumbnail's, not its own.
///
/// Deliberately the thumbnail. It is what a message actually lays out, ffmpeg
/// has already baked any rotation metadata into it — a phone video reports
/// itself landscape and displays portrait, so the stream's own width and height
/// would describe a box turned on its side — and it is always 640 across, so
/// the ratio recorded is the one the browser will use.
///
/// Answers `None` until the thumbnail exists; nothing can be said about the
/// geometry of a video before the frame that stands for it has been chosen.
pub(crate) async fn probe_video_dimensions(video_path: &str) -> Option<(u32, u32)> {
    let thumb = format!("{}.thumb.jpg", video_path);
    if tokio::fs::metadata(&thumb).await.is_err() {
        return None;
    }
    probe_image_dimensions(&thumb).await
}

/// Record the size of a video's thumbnail against its upload, replacing
/// whatever an earlier thumbnail left there.
///
/// The thumbnail is what a message lays out, not the video (see
/// `probe_video_dimensions`), so a regenerated one that came out a different
/// shape — a legacy capture, or one taken before a conversion baked in a
/// rotation — leaves every reader reserving a box the picture no longer fits.
/// Regenerating without this is half the job: the picture is fixed and the
/// space held for it is still wrong.
///
/// Matched on the folder rather than the path because a conversion moves
/// `disk_path`, `filename` and `url` together, and the folder is the one thing
/// about an upload it cannot move.
pub(crate) async fn record_thumbnail_dimensions(state: &AppState, video_disk: &str) {
    let Some((w, h)) = probe_video_dimensions(video_disk).await else {
        return; // no thumbnail to measure; nothing to say about the geometry
    };
    let Some(folder) = upload_folder_path(video_disk)
        .and_then(|dir| dir.file_name().and_then(|n| n.to_str()).map(String::from))
    else {
        return;
    };
    let uploads = state.db.collection::<UploadRecord>("uploads");
    let _ = uploads
        .update_many(
            doc! { "folder": &folder },
            doc! { "$set": { "width": w as i64, "height": h as i64 } },
        )
        .await;
}

/// The URL an upload is served at. Folder and filename both come from the
/// server, but the filename is the one the user chose.
fn upload_url(headers: &HeaderMap, folder: &str, filename: &str) -> String {
    use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
    // The quote/paren/backslash group is not about URL parsing: these URLs get
    // written into CSS (`url('…')` for a name font) and into HTML attributes,
    // and a filename is user-chosen. Encoding them here means an upload's URL
    // is inert in every context that later quotes it.
    const ENCODE_SET: &AsciiSet = &CONTROLS
        .add(b' ')
        .add(b'"')
        .add(b'\'')
        .add(b'<')
        .add(b'>')
        .add(b'`')
        .add(b'#')
        .add(b'?')
        .add(b'{')
        .add(b'}')
        .add(b'(')
        .add(b')')
        .add(b'\\');
    let encoded = utf8_percent_encode(filename, ENCODE_SET).to_string();

    let host = headers
        .get("host")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("localhost:8000");
    let scheme = if host.starts_with("localhost") || host.starts_with("127.0.0.1") {
        "http"
    } else {
        "https"
    };
    format!("{scheme}://{host}/external/{folder}/{encoded}")
}

/// Everything between bytes landing on disk and a URL going back: the record,
/// the format conversions, the sidecars, the measurement.
///
/// Shared by the two upload paths, which differ only in how the bytes arrive
/// and had drifted into ninety identical lines apiece.
///
/// The record is written **first**, before any of that work. It used to be the
/// last statement, after a remux that can run for minutes — and a restart in
/// that window left a file on disk that no record named, which made it
/// invisible to the quota, to the uploads list, and to every purge path, all
/// of which work from records. It is updated in place once the work is done.
/// `folder` is what ties the two writes together, because remuxing an mkv
/// changes the filename, the disk path and the URL all at once.
async fn finalize_upload(
    state: &Arc<AppState>,
    headers: &HeaderMap,
    user_id: &str,
    folder: &str,
    path: String,
    filename: String,
    landed_size: u64,
) -> String {
    let uploads = state.db.collection::<UploadRecord>("uploads");
    let _ = uploads
        .insert_one(UploadRecord {
            user_id: user_id.to_string(),
            filename: filename.clone(),
            url: upload_url(headers, folder, &filename),
            disk_path: path.clone(),
            size: landed_size,
            uploaded_at: chrono::Utc::now().timestamp(),
            width: None,
            height: None,
            folder: folder.to_string(),
            processing: true,
            referenced_at: None,
        })
        .await;

    // Convert to browser-compatible format / apply faststart
    let (path, filename) = postprocess_video(&path, &filename).await;

    let ext = filename
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();

    // Generate first-frame thumbnail for video files
    if is_thumbnailed_video(&ext) {
        generate_thumbnail(&path).await;
        extract_subtitles(&path).await;
    }
    // Generate a downscaled WebP preview for still images
    if is_previewable_image(&ext) {
        generate_image_preview(&path).await;
    }

    // Recalculate file size after potential conversion
    let final_size = tokio::fs::metadata(&path)
        .await
        .map(|m| m.len())
        .unwrap_or(landed_size);

    // Measured here rather than on the way out: the answer never changes, and a
    // reader scrolling history cannot wait on an ffprobe per image.
    let (width, height) = if is_measurable_image(&ext) {
        probe_image_dimensions(&path).await.unzip()
    } else if is_thumbnailed_video(&ext) {
        // The thumbnail was generated above, so this measures the picture the
        // timeline will lay out rather than the video behind it.
        probe_video_dimensions(&path).await.unzip()
    } else {
        (None, None)
    };

    let url = upload_url(headers, folder, &filename);
    let _ = uploads
        .update_one(
            doc! { "folder": folder },
            doc! { "$set": {
                "filename": &filename,
                "url": &url,
                "disk_path": &path,
                "size": final_size as i64,
                "width": width.map(|w| w as i64),
                "height": height.map(|h| h as i64),
                "processing": false,
            }},
        )
        .await;

    url
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

    // Guarded before any disk work: an upload costs a write, ffprobe, a
    // thumbnail and sometimes a transcode.
    if let Err(retry_after) =
        ratelimit::check(&state, &format!("upload:{user_id}"), ratelimit::UPLOAD).await
    {
        return rate_limited(retry_after, "You are uploading too quickly");
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

    let url = finalize_upload(
        &state,
        &headers,
        &user_id,
        &folder,
        path,
        filename,
        data.len() as u64,
    )
    .await;

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
    /// The size these chunks were sliced to — `CHUNK_SIZE` as it stood when
    /// the upload started, recorded rather than read back from the constant.
    /// Changing the constant would otherwise reslice an upload already in
    /// flight, and a resuming client has to be told the boundaries its
    /// existing chunks were cut on, not the ones a new upload would use.
    #[serde(default = "default_chunk_size")]
    chunk_size: u64,
}

fn default_chunk_size() -> u64 {
    CHUNK_SIZE as u64
}

/// The staging directory for `upload_id`, or `None` if that is not an id this
/// server ever minted.
///
/// The check is what keeps the id out of the path: 32 hex characters cannot
/// contain a separator or a `..`, so the formatted path is always a direct
/// child of `external/.chunks`.
fn staging_dir(upload_id: &str) -> Option<String> {
    if upload_id.len() != 32 || !upload_id.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    Some(format!("external/.chunks/{}", upload_id))
}

/// What a finished chunked upload turned into, kept in the staging dir after
/// the chunks are deleted.
///
/// `complete` assembles, remuxes and probes, which for a long video runs past
/// the client's timeout — and a client that gave up then had no way to learn
/// the URL of a file that was sitting finished on disk. Recording the answer
/// makes `complete` idempotent: asking twice gets the same URL rather than a
/// second upload and a stranded first one.
#[derive(serde::Serialize, serde::Deserialize)]
struct ChunkResult {
    url: String,
}

async fn read_chunk_result(chunk_dir: &str) -> Option<ChunkResult> {
    let raw = tokio::fs::read_to_string(format!("{chunk_dir}/done.json"))
        .await
        .ok()?;
    serde_json::from_str(&raw).ok()
}

/// How many bytes of chunked upload are part-way through the staging area,
/// for one user or for everyone.
///
/// Read from the metadata rather than by measuring the chunks: what an upload
/// has reserved is the size it declared, not the part of it that has arrived.
pub(crate) async fn staging_bytes_for(user_id: Option<&str>) -> u64 {
    let Ok(mut entries) = tokio::fs::read_dir("external/.chunks").await else {
        // Created by the first chunked upload, so its absence is the ordinary
        // state of a server nobody has uploaded a large file to.
        return 0;
    };
    let mut total = 0u64;
    while let Ok(Some(entry)) = entries.next_entry().await {
        let Some(dir) = entry.path().to_str().map(String::from) else {
            continue;
        };
        // A finished upload's dir lingers holding only its result, and those
        // bytes are a record now — counting them here would charge for them
        // twice.
        if read_chunk_result(&dir).await.is_some() {
            continue;
        }
        let Some(meta) = read_chunk_meta(&dir).await else {
            continue;
        };
        if user_id.is_none_or(|id| meta.user_id == id) {
            total += meta.file_size;
        }
    }
    total
}

async fn read_chunk_meta(chunk_dir: &str) -> Option<ChunkMeta> {
    let raw = tokio::fs::read_to_string(format!("{chunk_dir}/meta.json"))
        .await
        .ok()?;
    serde_json::from_str(&raw).ok()
}

/// How long chunk `index` has to be: a full chunk, or the remainder for the
/// last one.
fn expected_chunk_len(meta: &ChunkMeta, index: u64) -> u64 {
    let offset = index.saturating_mul(meta.chunk_size);
    std::cmp::min(meta.chunk_size, meta.file_size.saturating_sub(offset))
}

/// Which chunks are on disk *and* the right length, in index order.
///
/// Length rather than mere presence, because a chunk is written with a single
/// `write` that a killed process can leave half-finished, and nothing else
/// looks: `upload_complete` asks only whether each file exists. A resuming
/// client told such a chunk had landed would skip it and assemble a corrupt
/// file — the one failure this whole endpoint exists to prevent.
async fn received_chunks(chunk_dir: &str, meta: &ChunkMeta) -> Vec<u64> {
    let mut received: Vec<u64> = Vec::new();
    let Ok(mut entries) = tokio::fs::read_dir(chunk_dir).await else {
        return received;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        // Chunks are named by index, so `meta.json` falls out here.
        let Some(index) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<u64>().ok())
        else {
            continue;
        };
        if index >= meta.chunk_count {
            continue;
        }
        let Ok(len) = entry.metadata().await.map(|m| m.len()) else {
            continue;
        };
        if len == expected_chunk_len(meta, index) {
            received.push(index);
        }
    }
    received.sort_unstable();
    received
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
        chunk_size: CHUNK_SIZE as u64,
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
    let mut checksum: Option<String> = None;

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
            // Optional: a client without SubtleCrypto — which is absent on a
            // plain-http origin — cannot produce one, and an upload is not
            // worth refusing over a hash it has no way to compute. Verified
            // whenever it is sent.
            "checksum" => {
                if let Ok(text) = field.text().await {
                    checksum = Some(text.trim().to_ascii_lowercase());
                }
            }
            "file" => match field.bytes().await {
                Ok(b) => chunk_data = Some(b),
                Err(_) => return error_response(StatusCode::BAD_REQUEST, "Failed to read chunk"),
            },
            _ => {}
        }
    }

    let chunk_dir = match staging_dir(&upload_id) {
        Some(dir) => dir,
        None => return error_response(StatusCode::BAD_REQUEST, "Invalid uploadId"),
    };
    let chunk_index = match chunk_index {
        Some(i) => i,
        None => return error_response(StatusCode::BAD_REQUEST, "Missing chunkIndex"),
    };
    let chunk_data = match chunk_data {
        Some(d) => d,
        None => return error_response(StatusCode::BAD_REQUEST, "Missing file data"),
    };

    let meta = match read_chunk_meta(&chunk_dir).await {
        Some(m) => m,
        None => return error_response(StatusCode::NOT_FOUND, "Upload not found"),
    };

    if meta.user_id != user_id {
        return error_response(StatusCode::FORBIDDEN, "Not your upload");
    }
    if chunk_index >= meta.chunk_count {
        return error_response(StatusCode::BAD_REQUEST, "chunkIndex out of range");
    }

    // A chunk has exactly one correct length: a full one, or the remainder for
    // the last. Nothing downstream checks this — `upload_complete` asks only
    // whether each chunk file *exists* — so a request cut short by a proxy, or
    // a client slicing to a different chunk size than this server assembles
    // with, used to be written as-is and concatenated into a corrupt file that
    // was reported as a successful upload.
    let expected_len = expected_chunk_len(&meta, chunk_index);
    let received_len = chunk_data.len() as u64;
    if received_len != expected_len {
        return error_response(
            StatusCode::BAD_REQUEST,
            &format!("Chunk {chunk_index} is {received_len} bytes, expected {expected_len}"),
        );
    }

    // The length catches a truncation; only a hash catches the bytes arriving
    // wrong. Checked here rather than at assembly so a bad chunk fails as
    // itself and can be retried on its own.
    if let Some(expected) = &checksum {
        use sha2::{Digest, Sha256};
        let actual = hex::encode(Sha256::digest(&chunk_data));
        if &actual != expected {
            return error_response(
                StatusCode::BAD_REQUEST,
                &format!("Chunk {chunk_index} failed its checksum"),
            );
        }
    }

    let chunk_path = format!("{}/{}", chunk_dir, chunk_index);
    if tokio::fs::write(&chunk_path, &chunk_data).await.is_err() {
        return error_response(StatusCode::INTERNAL_SERVER_ERROR, "Failed to write chunk");
    }

    (StatusCode::OK, Json(json!({ "received": chunk_index })))
}

/// What the server still holds of a chunked upload.
///
/// The one thing a client cannot work out for itself. Without it an upload
/// broken halfway can only be started again from the beginning: the chunks it
/// already sent are on disk, addressed by an id the client may still have, and
/// nothing could ask about them. `received` is the list to skip; everything
/// else in `0..chunkCount` is what is left to send.
pub(crate) async fn upload_status(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(upload_id): AxumPath<String>,
) -> impl IntoResponse {
    let token = match extract_token(&headers) {
        Some(t) => t,
        None => return error_response(StatusCode::UNAUTHORIZED, "Missing token"),
    };
    let user_id = match get_user_from_token(&state, &token) {
        Some(uid) => uid,
        None => return error_response(StatusCode::UNAUTHORIZED, "Invalid token"),
    };

    let chunk_dir = match staging_dir(&upload_id) {
        Some(dir) => dir,
        None => return error_response(StatusCode::BAD_REQUEST, "Invalid uploadId"),
    };
    // Swept, completed, or never existed — all the same answer to a client,
    // which starts over in every one of those cases.
    let meta = match read_chunk_meta(&chunk_dir).await {
        Some(m) => m,
        None => return error_response(StatusCode::NOT_FOUND, "Upload not found"),
    };
    if meta.user_id != user_id {
        return error_response(StatusCode::FORBIDDEN, "Not your upload");
    }

    // A finished upload holds no chunks, so answering the ordinary way would
    // tell a resuming client to send the whole file again into a staging dir
    // that is only waiting to be swept.
    if let Some(done) = read_chunk_result(&chunk_dir).await {
        return (
            StatusCode::OK,
            Json(json!({
                "uploadId": upload_id,
                "filename": meta.filename,
                "fileSize": meta.file_size,
                "chunkSize": meta.chunk_size,
                "chunkCount": meta.chunk_count,
                "received": [],
                "receivedBytes": 0,
                "status": "done",
                "resultUrl": done.url,
            })),
        );
    }

    let received = received_chunks(&chunk_dir, &meta).await;
    let received_bytes: u64 = received
        .iter()
        .map(|index| expected_chunk_len(&meta, *index))
        .sum();

    (
        StatusCode::OK,
        Json(json!({
            "uploadId": upload_id,
            "filename": meta.filename,
            "fileSize": meta.file_size,
            "chunkSize": meta.chunk_size,
            "chunkCount": meta.chunk_count,
            "received": received,
            "receivedBytes": received_bytes,
            "status": "receiving",
        })),
    )
}

/// Give up on a chunked upload and take its staging directory with it.
///
/// `sweep_abandoned_chunks` would get there eventually, but "eventually" is up
/// to 25 hours of 10MB blocks for an upload the person cancelled on purpose
/// and already knows they are never finishing.
///
/// Idempotent: an id with nothing behind it answers the same as one that had a
/// directory, because a client that cancels twice — or cancels something the
/// sweeper already took — wants the same outcome either way.
pub(crate) async fn upload_abort(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(upload_id): AxumPath<String>,
) -> impl IntoResponse {
    let token = match extract_token(&headers) {
        Some(t) => t,
        None => return error_response(StatusCode::UNAUTHORIZED, "Missing token"),
    };
    let user_id = match get_user_from_token(&state, &token) {
        Some(uid) => uid,
        None => return error_response(StatusCode::UNAUTHORIZED, "Invalid token"),
    };

    let chunk_dir = match staging_dir(&upload_id) {
        Some(dir) => dir,
        None => return error_response(StatusCode::BAD_REQUEST, "Invalid uploadId"),
    };

    // Ownership is checked against the metadata, so an upload whose metadata
    // has already gone is nothing anyone can be refused — there is no one left
    // to refuse them on behalf of.
    if let Some(meta) = read_chunk_meta(&chunk_dir).await {
        if meta.user_id != user_id {
            return error_response(StatusCode::FORBIDDEN, "Not your upload");
        }
        let _ = tokio::fs::remove_dir_all(&chunk_dir).await;
    }

    (StatusCode::OK, Json(json!({ "aborted": true })))
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

    let chunk_dir = match staging_dir(&body.upload_id) {
        Some(dir) => dir,
        None => return error_response(StatusCode::BAD_REQUEST, "Invalid uploadId"),
    };
    let meta = match read_chunk_meta(&chunk_dir).await {
        Some(m) => m,
        None => return error_response(StatusCode::NOT_FOUND, "Upload not found"),
    };

    if meta.user_id != user_id {
        return error_response(StatusCode::FORBIDDEN, "Not your upload");
    }

    // Already assembled. The first call did the work and the client did not
    // hear the answer, so give it the same answer rather than doing it again.
    if let Some(done) = read_chunk_result(&chunk_dir).await {
        return (StatusCode::OK, Json(json!({ "url": done.url })));
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

    // The one end-to-end check available: the client said how big this file
    // would be at init, and the pieces have to add up to it. It was summed here
    // already and used only to report a size, so an upload that lost or
    // duplicated a whole chunk still completed with a 200.
    //
    // Unrecoverable by a second `complete`, unlike the I/O failures above, so
    // the staging dir goes with the partial file rather than being left to be
    // retried.
    let declared_size = meta.file_size;
    if total_size != declared_size {
        let _ = tokio::fs::remove_file(&path).await;
        let _ = tokio::fs::remove_dir_all(&chunk_dir).await;
        return error_response(
            StatusCode::BAD_REQUEST,
            &format!(
                "Assembled {total_size} bytes, expected {declared_size} — upload the file again"
            ),
        );
    }

    // The chunks have served their purpose, but the staging dir stays: it is
    // where the result is recorded, so that a client whose `complete` timed out
    // — which a long remux makes ordinary — can ask again instead of leaving a
    // finished file on disk that nobody ever referenced.
    for i in 0..meta.chunk_count {
        let _ = tokio::fs::remove_file(format!("{}/{}", chunk_dir, i)).await;
    }

    // Flush the file handle before post-processing
    drop(file);

    let url = finalize_upload(
        &state,
        &headers,
        &user_id,
        &folder,
        path,
        filename.clone(),
        total_size,
    )
    .await;

    // Written after the work rather than before it: this is the record that
    // says the upload is finished, and a second `complete` reads it instead of
    // starting the conversions over.
    let _ = tokio::fs::write(
        format!("{chunk_dir}/done.json"),
        serde_json::to_string(&ChunkResult { url: url.clone() }).unwrap_or_default(),
    )
    .await;

    (StatusCode::OK, Json(json!({ "url": url })))
}

// ---------------------------------------------------------------------------
// Link preview
// ---------------------------------------------------------------------------

/// What the last reclaim pass did, for the admin dashboard.
///
/// A global rather than `AppState` for the same reason `MEDIA_JOBS` is one:
/// the sweep is a detached task that holds a state handle and nothing else,
/// and threading a field back out would be plumbing for the sake of four
/// numbers nobody decides anything with.
pub(crate) static LAST_RECLAIM: LazyLock<std::sync::Mutex<ReclaimReport>> =
    LazyLock::new(|| std::sync::Mutex::new(ReclaimReport::default()));

#[derive(Default, Clone, Copy)]
pub(crate) struct ReclaimReport {
    pub(crate) ran_at_ms: u64,
    pub(crate) considered: u64,
    pub(crate) kept: u64,
    pub(crate) reclaimed: u64,
    pub(crate) reclaimed_bytes: u64,
    /// True when the pass only reported what it would have taken.
    pub(crate) dry_run: bool,
}

/// Every upload folder named anywhere in the database.
///
/// Walks whole documents rather than named fields: a URL can be written into a
/// message body, a profile, a room's sound pack, a forum post's image list, an
/// event's cover. Enumerating those fields means this quietly stops being true
/// the next time somebody adds one — and the cost of being wrong here is
/// deleting a file that is still in use.
///
/// `None` means a query failed, which is not the same as finding nothing: a
/// pass that cannot read the references must delete nothing at all.
async fn referenced_folders(state: &Arc<AppState>) -> Option<HashSet<String>> {
    let mut found: HashSet<String> = HashSet::new();

    // Messages carry their attachments in the body, and are the only
    // collection here big enough to be worth projecting down.
    let messages = state.db.collection::<mongodb::bson::Document>("messages");
    let mut cursor = messages
        .find(doc! { "redacted": { "$ne": true } })
        .projection(doc! { "content.body": 1 })
        .await
        .ok()?;
    while let Some(doc) = cursor.try_next().await.ok()? {
        collect_folders(&mongodb::bson::Bson::Document(doc), &mut found);
    }

    // Everything else that can hold a URL, read whole. All small.
    for name in [
        "users",
        "rooms",
        "channels",
        "events",
        "forum_posts",
        "forum_comments",
        "webhooks",
        "bots",
        "drafts",
    ] {
        let coll = state.db.collection::<mongodb::bson::Document>(name);
        let mut cursor = coll.find(doc! {}).await.ok()?;
        while let Some(doc) = cursor.try_next().await.ok()? {
            collect_folders(&mongodb::bson::Bson::Document(doc), &mut found);
        }
    }

    Some(found)
}

/// Every upload folder named by any string anywhere inside `value`.
fn collect_folders(value: &mongodb::bson::Bson, out: &mut HashSet<String>) {
    match value {
        mongodb::bson::Bson::String(text) => out.extend(attachment_folders(text)),
        mongodb::bson::Bson::Array(items) => {
            for item in items {
                collect_folders(item, out);
            }
        }
        mongodb::bson::Bson::Document(doc) => {
            for (_, field) in doc {
                collect_folders(field, out);
            }
        }
        _ => {}
    }
}

/// Reclaim uploads that completed and were then never referenced by anything.
///
/// The orphan no other sweep can see. An upload that finishes and is never
/// posted — the send failed, the tab closed, the profile save errored after
/// the avatar went up — leaves a file on disk and a record against the
/// uploader's quota, indistinguishable from one still in use.
///
/// Two things keep this safe. A candidate has to have gone a whole day
/// unclaimed, and every surface references a URL within seconds of uploading
/// it. And a pass that cannot read the references deletes nothing: the
/// question is "is this definitely unused", never "did I fail to find a use".
///
/// In the steady state the claims on `send_message` and the rest mean there
/// are no candidates and the scan never runs. It is the backlog from before
/// claiming existed that this works through, a batch at a time.
pub(crate) async fn sweep_unreferenced_uploads(state: Arc<AppState>) {
    use crate::backend::constants::{UPLOAD_GRACE_SECS, UPLOAD_SWEEP_BATCH, UPLOAD_SWEEP_SECS};

    let mut interval = tokio::time::interval(std::time::Duration::from_secs(UPLOAD_SWEEP_SECS));
    interval.tick().await; // skip the immediate first tick

    let uploads = state.db.collection::<UploadRecord>("uploads");
    let mut last_full_pass_ms = 0u64;

    loop {
        interval.tick().await;

        let dry_run = !state
            .server_settings
            .read()
            .await
            .reclaim_unreferenced_uploads;

        // A pass that only reports finds the same files again next hour, since
        // it takes none of them — so on the default setting this would scan
        // every message on the instance once an hour, forever, to reprint a
        // number nobody asked for twice. Once a day says the same thing.
        if dry_run
            && last_full_pass_ms > 0
            && now_millis_u64().saturating_sub(last_full_pass_ms)
                < (UPLOAD_GRACE_SECS as u64) * 1000
        {
            continue;
        }

        let cutoff = chrono::Utc::now().timestamp() - UPLOAD_GRACE_SECS;
        let Ok(mut cursor) = uploads
            .find(doc! { "referenced_at": null, "uploaded_at": { "$lt": cutoff } })
            .limit(UPLOAD_SWEEP_BATCH as i64)
            .await
        else {
            continue;
        };

        let mut candidates: Vec<UploadRecord> = Vec::new();
        while let Ok(Some(record)) = cursor.try_next().await {
            candidates.push(record);
        }
        if candidates.is_empty() {
            continue;
        }

        // One pass over the references for the whole batch, rather than a
        // scan per candidate — a regex over message bodies is a collection
        // scan, and two hundred of them an hour is not a background job.
        let Some(kept) = referenced_folders(&state).await else {
            eprintln!("[uploads] reclaim skipped: could not read what references what");
            continue;
        };

        last_full_pass_ms = now_millis_u64();

        let mut report = ReclaimReport {
            ran_at_ms: last_full_pass_ms,
            considered: candidates.len() as u64,
            dry_run,
            ..Default::default()
        };

        let mut in_use: Vec<String> = Vec::new();
        let mut unjudgeable: Vec<String> = Vec::new();

        for record in &candidates {
            // No folder means the startup migration could not work out where
            // this upload lives, so there is nothing to look for and no way to
            // tell whether it is in use.
            if !is_upload_folder(&record.folder) {
                unjudgeable.push(record.url.clone());
                report.kept += 1;
                continue;
            }
            if kept.contains(&record.folder) {
                in_use.push(record.folder.clone());
                report.kept += 1;
                continue;
            }

            report.reclaimed += 1;
            report.reclaimed_bytes += record.size;
            if dry_run {
                eprintln!(
                    "[uploads] would reclaim {} ({} bytes, uploaded by {})",
                    record.filename, record.size, record.user_id
                );
            } else {
                remove_upload_record(&state, record).await;
            }
        }

        // Claimed in one write rather than one apiece, and claimed at all so
        // that these stop being candidates — an upload that keeps coming back
        // as a candidate is what keeps the scan above running.
        mark_referenced(&state, &in_use).await;
        if !unjudgeable.is_empty() {
            // Left alone is the only safe answer for these, and marking them
            // means only that the question does not have to be asked again.
            let _ = uploads
                .update_many(
                    doc! { "url": { "$in": &unjudgeable } },
                    doc! { "$set": { "referenced_at": chrono::Utc::now().timestamp() } },
                )
                .await;
        }

        if report.reclaimed > 0 {
            eprintln!(
                "[uploads] {} {} unreferenced upload(s), {} bytes",
                if dry_run {
                    "would reclaim"
                } else {
                    "reclaimed"
                },
                report.reclaimed,
                report.reclaimed_bytes,
            );
        }
        if let Ok(mut last) = LAST_RECLAIM.lock() {
            *last = report;
        }
    }
}

fn now_millis_u64() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Startup reconciliation: upload folders on disk that no record names.
///
/// The shape a crash between writing the file and writing its record used to
/// leave behind, before `finalize_upload` started recording first. Such a
/// folder is invisible to the quota, to the uploads list and to every purge
/// path, all of which work from records — so nothing but the disk knows it is
/// there.
///
/// Runs once at startup rather than on a timer: it is a scan of the whole
/// upload tree, and the condition it repairs is only created by a restart.
pub(crate) async fn reconcile_upload_folders(state: Arc<AppState>) {
    use crate::backend::constants::UPLOAD_GRACE_SECS;

    let uploads = state.db.collection::<UploadRecord>("uploads");
    let Ok(mut cursor) = uploads.find(doc! {}).await else {
        return;
    };
    let mut known: HashSet<String> = HashSet::new();
    while let Ok(Some(record)) = cursor.try_next().await {
        if is_upload_folder(&record.folder) {
            known.insert(record.folder);
        } else if let Some(dir) = upload_folder_path(&record.disk_path) {
            if let Some(name) = dir.file_name().and_then(|n| n.to_str()) {
                known.insert(name.to_string());
            }
        }
    }

    let Ok(mut entries) = tokio::fs::read_dir("external").await else {
        return;
    };
    let grace = std::time::Duration::from_secs(UPLOAD_GRACE_SECS as u64);
    let mut reclaimed = 0usize;

    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        // `.chunks` and anything else not laid out by an upload. The 32-hex
        // shape is the whole guard here: this deletes directories.
        if !is_upload_folder(name) || known.contains(name) {
            continue;
        }
        if !entry.file_type().await.map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        // An upload being written right now has no record for a moment. Dating
        // it from the folder keeps this from racing one.
        let Some(idle) = idle_since_last_write(&entry.path()).await else {
            continue;
        };
        if idle >= grace && tokio::fs::remove_dir_all(entry.path()).await.is_ok() {
            reclaimed += 1;
        }
    }

    if reclaimed > 0 {
        eprintln!("[uploads] removed {reclaimed} folder(s) no record named");
    }
}

/// Collect staging dirs for chunked uploads nobody is going to finish.
///
/// `upload_init` creates `external/.chunks/<id>/` and only a successful
/// `upload_complete` removes it. A client that closed its tab, lost its
/// connection, or gave up after its retries left the chunks it had already
/// sent behind for good — 10MB apiece, with nothing anywhere in the tree
/// collecting them. Runs for the life of the process, like the presence sweep,
/// because an abandoned upload is the absence of a request and nothing else
/// can notice it.
pub(crate) async fn sweep_abandoned_chunks() {
    use crate::backend::constants::{CHUNK_ABANDONED_SECS, CHUNK_SWEEP_SECS};

    let mut interval = tokio::time::interval(std::time::Duration::from_secs(CHUNK_SWEEP_SECS));
    interval.tick().await; // skip the immediate first tick

    let abandoned_after = std::time::Duration::from_secs(CHUNK_ABANDONED_SECS);

    loop {
        interval.tick().await;

        // Created lazily by the first chunked upload, so its absence is the
        // normal state of a server nobody has uploaded to in pieces.
        let Ok(mut entries) = tokio::fs::read_dir("external/.chunks").await else {
            continue;
        };

        while let Ok(Some(entry)) = entries.next_entry().await {
            if !entry.file_type().await.map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let path = entry.path();
            // An unreadable dir is left alone rather than guessed about: the
            // cost of waiting another hour is nothing, and the cost of being
            // wrong is deleting an upload in flight.
            let Some(idle) = idle_since_last_write(&path).await else {
                continue;
            };
            if idle >= abandoned_after && tokio::fs::remove_dir_all(&path).await.is_ok() {
                eprintln!("[chunks] swept abandoned upload {}", path.display());
            }
        }
    }
}

/// How long ago anything in `dir` was last written.
///
/// The most recent write anywhere inside it, not the dir's own creation: an
/// upload that is merely slow is still arriving, and dating it from `init`
/// would reap it out from under a client that is still sending.
async fn idle_since_last_write(dir: &std::path::Path) -> Option<std::time::Duration> {
    let mut newest: Option<std::time::SystemTime> = None;
    let mut entries = tokio::fs::read_dir(dir).await.ok()?;
    while let Ok(Some(entry)) = entries.next_entry().await {
        let Ok(modified) = entry.metadata().await.and_then(|m| m.modified()) else {
            continue;
        };
        if newest.is_none_or(|n| modified > n) {
            newest = Some(modified);
        }
    }
    // `meta.json` is written at init, so an empty dir means a failure between
    // creating it and writing that — date it from the dir itself.
    let newest = match newest {
        Some(t) => t,
        None => tokio::fs::metadata(dir).await.ok()?.modified().ok()?,
    };
    // A modification time in the future says the clock moved, not that the
    // upload is fresh; treated as untellable rather than as newly touched.
    std::time::SystemTime::now().duration_since(newest).ok()
}

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

/// The uploads a message body refers to, named by the folder each one owns.
///
/// Attachments are posted as bare URLs in the body, which is also how
/// `body_has_attachment` in messages.rs judges them.
///
/// The folder rather than the whole URL, because one file has several names:
/// the absolute URL the upload was handed back on, the same file through
/// another hostname this instance answers to, and a bare `/external/...` path.
/// This used to match only the last of those while uploads have always been
/// handed back as absolute URLs — so it found nothing in a real message, and
/// the purge on the other side of it had never once run. Every form carries
/// the same random folder, and that folder is on the record.
///
/// Erring toward finding fewer is the safe direction: the worst case is a file
/// outliving its message, where over-matching would delete one that another
/// message still needs.
pub(crate) fn attachment_folders(body: &str) -> Vec<String> {
    let mut folders: Vec<String> = body
        .split_whitespace()
        // Punctuation from the prose a link was pasted into, on both sides.
        .map(|token| {
            token
                .trim_start_matches(['(', '[', '<', '"', '\''])
                .trim_end_matches(['.', ',', ')', ']', '>', '"', '\'', '!', '?'])
        })
        .filter_map(|token| {
            let rest = token.split("/external/").nth(1)?;
            let folder = rest.split('/').next()?;
            // Uploads live in a random 32-hex folder with the file inside it.
            // Anything else under `/external/` is a path this server did not
            // write, and nothing here should act on one.
            let named_a_file = rest.len() > folder.len() + 1;
            if named_a_file && is_upload_folder(folder) {
                Some(folder.to_string())
            } else {
                None
            }
        })
        .collect();
    folders.sort();
    folders.dedup();
    folders
}

fn is_upload_folder(folder: &str) -> bool {
    folder.len() == 32 && folder.chars().all(|c| c.is_ascii_hexdigit())
}

/// The `external/<folder>` directory an upload owns, if its `disk_path` names
/// one.
///
/// Guarded rather than trusted, because this is what a recursive delete gets
/// pointed at and the difference between `external/<folder>` and `external` is
/// every upload on the instance.
fn upload_folder_path(disk_path: &str) -> Option<std::path::PathBuf> {
    let parent = std::path::Path::new(disk_path).parent()?;
    // Exactly one level below the root, and not the root itself.
    if parent.parent() != Some(std::path::Path::new("external")) {
        return None;
    }
    let name = parent.file_name()?.to_str()?;
    if !is_upload_folder(name) {
        return None;
    }
    Some(parent.to_path_buf())
}

/// Remove an uploaded file and its record, together with the sidecars derived
/// from it — a thumbnail, a preview, extracted subtitles.
async fn remove_upload_record(state: &Arc<AppState>, record: &UploadRecord) {
    // An upload owns its whole folder — one random folder per file — so taking
    // the folder takes the file and every sidecar with it, whatever they are
    // named. Naming the suffixes one by one missed the `@N.vtt` subtitle
    // tracks, and every file left behind then made the `remove_dir` that
    // followed fail, so a deleted upload left its directory, its thumbnail and
    // its preview on disk permanently.
    if let Some(folder) = upload_folder_path(&record.disk_path) {
        let _ = tokio::fs::remove_dir_all(&folder).await;
    } else {
        // A record from something that did not follow that layout. Take what
        // can be named and nothing else.
        let _ = tokio::fs::remove_file(&record.disk_path).await;
        for suffix in [".thumb.jpg", ".preview.webp", "@subs.json", ".faststarted"] {
            let _ = tokio::fs::remove_file(format!("{}{suffix}", record.disk_path)).await;
        }
    }
    let _ = state
        .db
        .collection::<UploadRecord>("uploads")
        .delete_one(doc! { "url": &record.url })
        .await;
}

/// Delete the files a message referred to, unless something else still refers
/// to them.
///
/// The reference check is what keeps this safe: the same URL can be pasted
/// into a second message, and deleting the first must not break the second.
/// It costs a scan, which is acceptable only because deleting is rare — do not
/// reach for this on a hot path.
///
/// `owner` restricts deletion to files that user uploaded; `None` skips the
/// check, for when the owner is already known to be going away.
/// `excluding_event` is the message being deleted, which must not count as a
/// reference to itself.
pub(crate) async fn purge_attachments(
    state: &Arc<AppState>,
    folders: &[String],
    owner: Option<&str>,
    excluding_event: Option<&str>,
) {
    use super::super::helpers::regex_escape;

    let uploads = state.db.collection::<UploadRecord>("uploads");
    let messages = state.db.collection::<mongodb::bson::Document>("messages");

    for folder in folders {
        if !is_upload_folder(folder) {
            continue;
        }
        let mut query = doc! { "folder": folder };
        if let Some(owner) = owner {
            query.insert("user_id", owner);
        }
        let Ok(Some(record)) = uploads.find_one(query).await else {
            continue;
        };

        // Matched on the folder segment for the same reason it was collected
        // that way: the same file appears in other messages under whichever
        // hostname the person who posted it was using.
        let mut still_used = doc! {
            "content.body": { "$regex": regex_escape(&format!("/external/{folder}/")) },
            "redacted": { "$ne": true },
        };
        if let Some(event_id) = excluding_event {
            still_used.insert("event_id", doc! { "$ne": event_id });
        }
        if messages.find_one(still_used).await.ok().flatten().is_some() {
            continue;
        }

        remove_upload_record(state, &record).await;
    }
}

/// Note that something now points at these uploads, so a sweep for files
/// nothing kept can pass over them.
///
/// Best effort, and deliberately not ordered against the write that referenced
/// them: claiming an upload twice is free, and a claim that does not land only
/// means the reachability scan has to work the reference out for itself.
pub(crate) async fn mark_referenced(state: &Arc<AppState>, folders: &[String]) {
    let folders: Vec<&String> = folders.iter().filter(|f| is_upload_folder(f)).collect();
    if folders.is_empty() {
        return;
    }
    let _ = state
        .db
        .collection::<UploadRecord>("uploads")
        .update_many(
            doc! { "folder": { "$in": &folders }, "referenced_at": null },
            doc! { "$set": { "referenced_at": chrono::Utc::now().timestamp() } },
        )
        .await;
}

/// Delete everything a user ever uploaded.
///
/// Used when the account itself is going away, where there is no question of
/// another message still needing the file — the person it belonged to has
/// asked to be gone.
pub(crate) async fn purge_user_uploads(state: &Arc<AppState>, user_id: &str) {
    use futures_util::TryStreamExt;

    let uploads = state.db.collection::<UploadRecord>("uploads");
    let Ok(mut cursor) = uploads.find(doc! { "user_id": user_id }).await else {
        return;
    };
    let mut records: Vec<UploadRecord> = Vec::new();
    while let Ok(Some(record)) = cursor.try_next().await {
        records.push(record);
    }
    for record in &records {
        remove_upload_record(state, record).await;
    }
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
        .find_one(doc! { "user_id": &user_id, "url": &body.url })
        .await
        .ok()
        .flatten();

    match record {
        Some(rec) => {
            // Through the shared path rather than a partial copy of it: this
            // used to remove the file alone, leaving the thumbnail, the
            // preview and the subtitle tracks — which then kept the folder
            // from being removable at all.
            remove_upload_record(&state, &rec).await;
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

/// Sidecars this server derives from an upload and serves at a URL that never
/// changes — so, unlike the upload itself, their bytes *can* change.
///
/// Every one of these is generated on demand in `upload_guard` and some are
/// regenerated afterwards: `thumb_needs_update` replaces a stale thumbnail,
/// and `fix_black_thumbnails` rewrites the legacy all-black ones at startup.
/// Both do it in place, so a client told to cache one forever would keep the
/// bad picture and the repair would never reach it.
/// Matched against the raw, still-percent-encoded path: every suffix here is
/// ASCII that neither `upload_url`'s encode set nor a browser escapes, and the
/// `%40` spelling is allowed for the one that hangs off a literal `@` so a
/// client that does escape it cannot win an `immutable` by accident. Erring
/// this way only costs a revalidation; erring the other way pins a stale file.
fn is_regenerable_derivative(uri_path: &str) -> bool {
    uri_path.ends_with(".thumb.jpg")
        || uri_path.ends_with(".preview.webp")
        || uri_path.ends_with("@subs.json")
        || uri_path.ends_with("%40subs.json")
        || uri_path.ends_with(".vtt")
}

/// `Cache-Control` for a request under `/external`, by what the URL promises
/// about its bytes.
///
/// An upload lands in a folder named from 16 random bytes, so `<32 hex>/<name>`
/// identifies those exact bytes for good: a replacement avatar is a new folder
/// and therefore a new URL, which is what lets this be `immutable` without
/// costing anyone a stale profile picture. The broadcast that announces the
/// change carries the new URL, so every client fetches a name it has never
/// seen — cached or not, the update lands in one round trip.
///
/// Everything else here is something whose bytes can be replaced under a fixed
/// name — the derivatives above, and the built-in sounds at the `external/`
/// root, which an operator is free to swap — so those revalidate. ServeDir
/// sends `Last-Modified`, and a regenerated file has a newer one, so the
/// revalidation is a 304 until the moment it isn't.
///
/// `private` throughout, never `public`: `require_auth_for_uploads` can be on,
/// and it can be turned on *after* a response was cached, so a shared proxy
/// must never be allowed to hand one user's media to another.
fn cache_control_for(uri_path: &str) -> &'static str {
    const REVALIDATE: &str = "private, max-age=300, must-revalidate";
    const IMMUTABLE: &str = "private, max-age=31536000, immutable";

    if is_regenerable_derivative(uri_path) {
        return REVALIDATE;
    }
    // `<32 hex folder>/<filename>`, exactly one level below the root. Anything
    // shallower or deeper is not an upload this server laid out.
    let mut segments = uri_path.trim_start_matches('/').split('/');
    let Some(folder) = segments.next() else {
        return REVALIDATE;
    };
    let is_upload = segments.next().is_some_and(|name| !name.is_empty())
        && segments.next().is_none()
        && is_upload_folder(folder);

    if is_upload {
        IMMUTABLE
    } else {
        REVALIDATE
    }
}

/// Stamp `Cache-Control` on a response that carries file bytes.
///
/// Only on a success, and that is the whole point of doing this here rather
/// than with a `SetResponseHeaderLayer` over the router: a layer stamps every
/// response, and a 404 given explicit freshness is a 404 the browser is
/// entitled to keep. A preview whose source is not generated yet answers 404
/// (see the note in `AuthImage.tsx`), and that request is *expected* to
/// succeed on a later load — cached, it would leave a permanently empty frame
/// on that one client and nowhere else.
fn with_cache_control(mut resp: Response<Body>, uri_path: &str) -> Response<Body> {
    let cacheable = matches!(
        resp.status(),
        StatusCode::OK | StatusCode::PARTIAL_CONTENT | StatusCode::NOT_MODIFIED
    );
    if cacheable && !resp.headers().contains_key(header::CACHE_CONTROL) {
        if let Ok(value) = HeaderValue::from_str(cache_control_for(uri_path)) {
            resp.headers_mut().insert(header::CACHE_CONTROL, value);
        }
    }
    resp
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
        return with_cache_control(
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "text/plain")
                .body(Body::from(data))
                .unwrap(),
            &uri_path,
        );
    }

    // Generate (or regenerate stale/black) thumbnail on demand when the
    // .thumb.jpg is requested
    if uri_path.ends_with(".thumb.jpg") {
        if let Some(thumb_disk) = external_disk_path(&uri_path) {
            let video_disk = thumb_disk.strip_suffix(".thumb.jpg").unwrap_or(&thumb_disk);
            if thumb_needs_update(video_disk).await {
                remove_thumbnail(&thumb_disk).await;
                generate_thumbnail(video_disk).await;
                // What the message reserves space with is measured from the
                // thumbnail, so a new one has to be measured again.
                if let Some(state) = req.extensions().get::<Arc<AppState>>() {
                    record_thumbnail_dimensions(state, video_disk).await;
                }
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
                return with_cache_control(
                    Response::builder()
                        .status(StatusCode::OK)
                        .header(header::CONTENT_TYPE, content_type)
                        .body(Body::from(data))
                        .unwrap(),
                    &uri_path,
                );
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
            // Clients no longer ask for the preview of a video thumbnail, but
            // one running an older build still does, and the thumbnail it
            // names is generated on demand — so it may not be there to make a
            // preview from. Generating it here answers with a picture rather
            // than the 404 that leaves a black box in the message.
            if let Some(video_disk) = source_disk.strip_suffix(".thumb.jpg") {
                generate_thumbnail(video_disk).await;
            }
            generate_image_preview(source_disk).await;
        }
    }

    // For MP4/MOV files, apply faststart on first access so the moov atom
    // is at the front of the file — required for instant seeking in browsers.
    // Also generate a thumbnail if one doesn't exist yet.
    if matches!(ext.as_str(), "mp4" | "mov" | "m4v" | "webm" | "ogg") {
        let disk_path = external_disk_path(&uri_path).unwrap_or_default();

        if !disk_path.is_empty()
            && matches!(ext.as_str(), "mp4" | "mov" | "m4v")
            && tokio::fs::metadata(&disk_path).await.is_ok()
        {
            faststart_in_place(&disk_path, &ext).await;
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
            return with_cache_control(next.run(req).await.into_response(), &uri_path);
        }

        // Extract subtitle sidecars + manifest keyed to the ORIGINAL video.
        if tokio::fs::metadata(&disk_path).await.is_ok() {
            extract_subtitles(&disk_path).await;
        }

        // Convert if the cached MP4 doesn't exist yet. Parallel range requests
        // all land here at once, so only one of them gets to run the remux;
        // the rest wait and then find the finished MP4.
        if tokio::fs::metadata(&mp4_disk).await.is_err()
            && tokio::fs::metadata(&disk_path).await.is_ok()
        {
            let job = media_job_lock(&disk_path).await;
            let _guard = job.lock().await;
            if tokio::fs::metadata(&mp4_disk).await.is_err() {
                if let Some(tmp_path) = remux_with_subs(&disk_path).await {
                    let _ = tokio::fs::rename(&tmp_path, &mp4_disk).await;
                    // Already faststarted by the remux.
                    let _ = tokio::fs::write(format!("{}.faststarted", mp4_disk), b"").await;
                }
            }
        }

        // Lazily generate a thumbnail for the served MP4, then rewrite the
        // request to serve it
        if tokio::fs::metadata(&mp4_disk).await.is_ok() {
            generate_thumbnail(&mp4_disk).await;
            let (mut parts, body) = req.into_parts();
            parts.uri = mp4_uri.parse().unwrap_or(parts.uri);
            let req = axum::http::Request::from_parts(parts, body);
            // Keyed to the URI the client actually holds — the `.mkv` — not
            // the `.mp4` being served in its place. The remux finishes above
            // before a byte goes out, so what lands in the cache is the
            // converted file, not a half-made one.
            return with_cache_control(next.run(req).await.into_response(), &uri_path);
        }
    }

    // Pass through to ServeDir
    with_cache_control(next.run(req).await.into_response(), &uri_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ─── Chunk staging sweep ────────────────────────────────────────────────

    fn staging_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "chatter_chunks_{}_{}_{}",
            std::process::id(),
            name,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Backdate a file, so a staging dir can be made to look abandoned without
    /// a test having to wait a day for it.
    fn backdate(path: &std::path::Path, secs: u64) {
        let when = std::time::SystemTime::now() - std::time::Duration::from_secs(secs);
        let file = std::fs::File::options().write(true).open(path).unwrap();
        file.set_times(std::fs::FileTimes::new().set_modified(when))
            .unwrap();
    }

    #[tokio::test]
    async fn a_staging_dir_still_being_written_to_is_not_idle() {
        let dir = staging_dir("fresh");
        std::fs::write(dir.join("meta.json"), "{}").unwrap();

        let idle = idle_since_last_write(&dir).await.expect("a readable dir");
        assert!(
            idle < std::time::Duration::from_secs(60),
            "a dir just written to should not look idle, got {idle:?}"
        );

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn a_slow_upload_is_dated_from_its_newest_chunk() {
        // The case that makes dating from `init` wrong: a big upload whose
        // first chunks are hours old but which is still arriving. Reaping it
        // would delete an upload out from under the client sending it.
        let dir = staging_dir("slow");
        std::fs::write(dir.join("meta.json"), "{}").unwrap();
        std::fs::write(dir.join("0"), "old").unwrap();
        std::fs::write(dir.join("1"), "new").unwrap();
        backdate(&dir.join("meta.json"), 48 * 60 * 60);
        backdate(&dir.join("0"), 48 * 60 * 60);

        let idle = idle_since_last_write(&dir).await.expect("a readable dir");
        assert!(
            idle < std::time::Duration::from_secs(60),
            "the newest chunk should date the dir, got {idle:?}"
        );

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn an_upload_nobody_finished_reads_as_abandoned() {
        use crate::backend::constants::CHUNK_ABANDONED_SECS;

        let dir = staging_dir("abandoned");
        std::fs::write(dir.join("meta.json"), "{}").unwrap();
        std::fs::write(dir.join("0"), "chunk").unwrap();
        backdate(&dir.join("meta.json"), CHUNK_ABANDONED_SECS * 2);
        backdate(&dir.join("0"), CHUNK_ABANDONED_SECS * 2);

        let idle = idle_since_last_write(&dir).await.expect("a readable dir");
        assert!(
            idle >= std::time::Duration::from_secs(CHUNK_ABANDONED_SECS),
            "an untouched dir should pass the threshold, got {idle:?}"
        );

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn a_dir_that_cannot_be_read_is_left_alone() {
        // Untellable rather than old: the sweep deletes, so not knowing has to
        // mean doing nothing.
        let missing = std::env::temp_dir().join("chatter_chunks_definitely_not_here");
        let _ = std::fs::remove_dir_all(&missing);
        assert!(idle_since_last_write(&missing).await.is_none());
    }

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

    /// Report the container ffprobe detects for a file, or "" when it cannot
    /// be opened at all.
    async fn probe_format(path: &str) -> String {
        tokio::process::Command::new("ffprobe")
            .args([
                "-v",
                "error",
                "-show_entries",
                "format=format_name",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                path,
            ])
            .output()
            .await
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default()
    }

    /// Build an MKV shaped like an ordinary rip: H.264 video, AC-3 audio the
    /// MP4 container will not take as-is, and a SubRip caption track.
    async fn build_mkv_fixture() -> String {
        let dir = std::env::temp_dir().join(format!("chatter_mkv_{}", std::process::id()));
        let _ = tokio::fs::create_dir_all(&dir).await;
        let mkv = dir.join("movie.mkv").to_string_lossy().to_string();
        let subs = dir.join("movie_src.vtt").to_string_lossy().to_string();
        for suffix in ["", ".cc.tmp", ".faststarted", ".faststart.tmp"] {
            let _ = tokio::fs::remove_file(format!("{}{}", mkv, suffix)).await;
        }
        tokio::fs::write(
            &subs,
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
                &subs,
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-c:a",
                "ac3",
                "-c:s",
                "srt",
                "-shortest",
                &mkv,
            ])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .await
            .expect("ffmpeg should be available");
        assert!(status.success(), "mkv fixture build failed");
        mkv
    }

    /// An MKV whose video codec an MP4 cannot hold, so `-c:v copy` refuses it.
    ///
    /// Stands in for the family of files the old single command gave up on —
    /// a bitmap subtitle track, a codec MP4 will not take — all of which
    /// ended the same way: the Matroska file kept, and handed to a browser.
    async fn build_uncopyable_mkv_fixture() -> String {
        let dir = std::env::temp_dir().join(format!("chatter_vp8_{}", std::process::id()));
        let _ = tokio::fs::create_dir_all(&dir).await;
        let mkv = dir.join("uncopyable.mkv").to_string_lossy().to_string();
        for suffix in ["", ".cc.tmp"] {
            let _ = tokio::fs::remove_file(format!("{}{}", mkv, suffix)).await;
        }
        let status = tokio::process::Command::new("ffmpeg")
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc=duration=2:size=160x120:rate=10",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=2",
                "-c:v",
                "libvpx",
                "-b:v",
                "200k",
                "-c:a",
                "libopus",
                "-shortest",
                &mkv,
            ])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .await
            .expect("ffmpeg should be available");
        assert!(status.success(), "vp8 fixture build failed");
        mkv
    }

    #[tokio::test]
    async fn a_video_the_first_attempt_refuses_still_keeps_its_audio() {
        // The whole conversion used to be one command, so anything ffmpeg
        // refused kept the Matroska file — and a browser handed one of those
        // often plays the picture, finds an audio codec it cannot decode, and
        // greys out the track selector. A video that plays silently, with
        // nothing anywhere saying why.
        let mkv = build_uncopyable_mkv_fixture().await;

        let tmp = remux_with_subs(&mkv)
            .await
            .expect("the ladder should get there by re-encoding");

        let format = probe_format(&tmp).await;
        assert!(format.contains("mp4"), "not an MP4: {format:?}");

        let kinds = stream_kinds(&tmp).await;
        assert!(kinds.iter().any(|k| k == "video"), "video lost: {kinds:?}");
        assert!(
            kinds.iter().any(|k| k == "audio"),
            "audio lost — the failure this exists to prevent: {kinds:?}"
        );

        let _ = tokio::fs::remove_file(&tmp).await;
        let _ = tokio::fs::remove_file(&mkv).await;
    }

    #[tokio::test]
    async fn remux_writes_a_real_mp4_not_just_a_tmp_file() {
        let mkv = build_mkv_fixture().await;

        // Regression: the destination is `{src}.cc.tmp`, and ffmpeg picks its
        // muxer from the output extension. `.tmp` matches no format, so every
        // MKV conversion died with "Unable to choose an output format" before
        // reading a frame. The upload fell back to keeping the Matroska file,
        // the browser was handed a container it cannot play, and the video
        // spun on "loading" forever — while the captions, extracted by a
        // separate `-f webvtt` pass, worked fine.
        let tmp = remux_with_subs(&mkv).await.expect("remux should succeed");

        let format = probe_format(&tmp).await;
        assert!(
            format.contains("mp4"),
            "converted file is not an MP4: {format:?}"
        );

        let streams = tokio::process::Command::new("ffprobe")
            .args([
                "-v",
                "error",
                "-show_entries",
                "stream=codec_name",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                &tmp,
            ])
            .output()
            .await
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .unwrap_or_default();
        assert!(streams.contains("h264"), "video stream lost: {streams}");
        assert!(streams.contains("aac"), "audio not transcoded: {streams}");
        assert!(streams.contains("mov_text"), "captions lost: {streams}");

        let _ = tokio::fs::remove_file(&tmp).await;
        let _ = tokio::fs::remove_file(&mkv).await;
    }

    #[tokio::test]
    async fn faststart_rewrites_the_file_and_runs_once() {
        let dir = std::env::temp_dir().join(format!("chatter_fs_{}", std::process::id()));
        let _ = tokio::fs::create_dir_all(&dir).await;
        let mp4 = dir.join("clip.mp4").to_string_lossy().to_string();
        let marker = format!("{}.faststarted", mp4);
        let _ = tokio::fs::remove_file(&marker).await;
        let status = tokio::process::Command::new("ffmpeg")
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc=duration=3:size=320x240:rate=10",
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                &mp4,
            ])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .await
            .expect("ffmpeg should be available");
        assert!(status.success(), "mp4 fixture build failed");

        // Same `.tmp` output bug as the remux: the pass silently did nothing,
        // so uploaded MP4s kept their moov atom at the tail.
        assert!(faststart_in_place(&mp4, "mp4").await);
        assert!(probe_format(&mp4).await.contains("mp4"));
        assert!(
            tokio::fs::metadata(&marker).await.is_ok(),
            "marker not written; the pass would rerun on every request"
        );
        // The marker short-circuits the second call, so parallel range
        // requests do not each re-encode the file.
        assert!(faststart_in_place(&mp4, "mp4").await);

        for p in [&mp4, &marker] {
            let _ = tokio::fs::remove_file(p).await;
        }
    }

    // ─── Cache-Control scoping ──────────────────────────────────────────────

    const UPLOAD_FOLDER: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn an_upload_is_cached_for_good_because_its_url_names_its_bytes() {
        // The folder is 16 random bytes, so these bytes are the only ones this
        // URL will ever have. A replaced avatar is a new folder and a new URL.
        let cc = cache_control_for(&format!("/{UPLOAD_FOLDER}/avatar.png"));
        assert!(cc.contains("immutable"), "got {cc}");
        assert!(
            cc.starts_with("private"),
            "must not be proxy-cacheable: {cc}"
        );
    }

    #[test]
    fn a_regenerable_sidecar_revalidates() {
        // Each of these is generated on demand and can be *re*generated in
        // place — `fix_black_thumbnails` exists to do exactly that — so the
        // repair has to be able to reach a client that already has one.
        for path in [
            format!("/{UPLOAD_FOLDER}/clip.mp4.thumb.jpg"),
            format!("/{UPLOAD_FOLDER}/photo.png.preview.webp"),
            format!("/{UPLOAD_FOLDER}/clip.mkv@subs.json"),
            format!("/{UPLOAD_FOLDER}/clip.mkv%40subs.json"),
            format!("/{UPLOAD_FOLDER}/clip.mkv@0.vtt"),
        ] {
            let cc = cache_control_for(&path);
            assert!(
                !cc.contains("immutable"),
                "{path} can change under a fixed name, got {cc}"
            );
            assert!(cc.contains("must-revalidate"), "{path} got {cc}");
        }
    }

    #[test]
    fn the_built_in_sounds_stay_replaceable() {
        // These sit at the `external/` root rather than in a folder of their
        // own, and an operator is free to swap the files. Pinning them for a
        // year would make that change unobservable.
        for path in ["/vc-join.wav", "/mute.wav", "/unmute.wav"] {
            let cc = cache_control_for(path);
            assert!(!cc.contains("immutable"), "{path} got {cc}");
        }
    }

    #[test]
    fn only_the_upload_shape_counts_as_immutable() {
        // A folder that is not 32 hex characters was not laid out by this
        // server, and a path deeper or shallower than `<folder>/<file>` is not
        // an upload either.
        for path in [
            "/not-a-folder/avatar.png".to_string(),
            format!("/{UPLOAD_FOLDER}"),
            format!("/{UPLOAD_FOLDER}/"),
            format!("/{UPLOAD_FOLDER}/nested/avatar.png"),
        ] {
            let cc = cache_control_for(&path);
            assert!(!cc.contains("immutable"), "{path} got {cc}");
        }
    }

    #[test]
    fn a_failure_is_never_given_freshness() {
        // The reason this is a function and not a SetResponseHeaderLayer. A
        // preview whose source is not generated yet answers 404 and is
        // expected to succeed on a later load; a 404 handed explicit
        // freshness is one the browser may keep, which would leave a
        // permanently empty frame on that client alone.
        let path = format!("/{UPLOAD_FOLDER}/photo.png.preview.webp");
        for status in [
            StatusCode::NOT_FOUND,
            StatusCode::UNAUTHORIZED,
            StatusCode::INTERNAL_SERVER_ERROR,
        ] {
            let resp = with_cache_control(
                Response::builder()
                    .status(status)
                    .body(Body::empty())
                    .unwrap(),
                &path,
            );
            assert!(
                !resp.headers().contains_key(header::CACHE_CONTROL),
                "{status} must not be cacheable"
            );
        }
    }

    #[test]
    fn a_served_file_and_a_range_of_one_both_get_the_header() {
        let path = format!("/{UPLOAD_FOLDER}/clip.mp4");
        for status in [StatusCode::OK, StatusCode::PARTIAL_CONTENT] {
            let resp = with_cache_control(
                Response::builder()
                    .status(status)
                    .body(Body::empty())
                    .unwrap(),
                &path,
            );
            let cc = resp
                .headers()
                .get(header::CACHE_CONTROL)
                .and_then(|v| v.to_str().ok())
                .unwrap_or_default()
                .to_string();
            assert!(cc.contains("immutable"), "{status} got {cc:?}");
        }
    }

    #[test]
    fn a_header_already_set_upstream_is_left_alone() {
        let path = format!("/{UPLOAD_FOLDER}/avatar.png");
        let resp = with_cache_control(
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CACHE_CONTROL, "no-store")
                .body(Body::empty())
                .unwrap(),
            &path,
        );
        assert_eq!(
            resp.headers().get(header::CACHE_CONTROL).unwrap(),
            "no-store"
        );
    }

    #[test]
    fn attachment_folders_finds_posted_files() {
        const A: &str = "0123456789abcdef0123456789abcdef";
        const B: &str = "fedcba9876543210fedcba9876543210";

        // Attachments are posted as bare URLs in the body, sometimes alongside
        // text and sometimes several at once.
        assert_eq!(
            attachment_folders(&format!("look at this /external/{A}/cat.png")),
            vec![A],
        );
        assert_eq!(
            attachment_folders(&format!("/external/{A}/one.png\n/external/{B}/two.mp4")),
            vec![A, B],
        );
        assert!(attachment_folders("no attachments here").is_empty());
        // A remote link is not ours to delete.
        assert!(attachment_folders("https://elsewhere/cat.png").is_empty());
        // Nor is the bare prefix, or a folder with nothing in it.
        assert!(attachment_folders("/external/").is_empty());
        assert!(attachment_folders(&format!("/external/{A}/")).is_empty());
        // Nor anything under `external/` this server did not lay out.
        assert!(attachment_folders("/external/uploads/u1/cat.png").is_empty());
    }

    #[test]
    fn attachment_folders_recognises_a_file_by_any_of_its_names() {
        const A: &str = "0123456789abcdef0123456789abcdef";

        // An upload is handed back as an absolute URL and posted that way, so
        // matching only the bare path found nothing in a real message — and
        // the purge behind it had never once run. The same file reached
        // through a second hostname is still the same file.
        assert_eq!(
            attachment_folders(&format!("https://chat.example.com/external/{A}/cat.png")),
            vec![A],
        );
        assert_eq!(
            attachment_folders(&format!("http://localhost:8000/external/{A}/cat.png")),
            vec![A],
        );
        // And a file named twice is one file.
        assert_eq!(
            attachment_folders(&format!(
                "/external/{A}/cat.png and https://elsewhere.example/external/{A}/cat.png"
            )),
            vec![A],
        );
    }

    #[test]
    fn attachment_folders_strip_trailing_prose() {
        const A: &str = "0123456789abcdef0123456789abcdef";
        // A link pasted mid-sentence keeps the punctuation that followed it,
        // which would otherwise never match the stored upload.
        assert_eq!(
            attachment_folders(&format!("see /external/{A}/cat.png.")),
            vec![A]
        );
        assert_eq!(
            attachment_folders(&format!("(/external/{A}/cat.png)")),
            vec![A]
        );
    }

    #[test]
    fn references_are_found_wherever_a_url_was_written() {
        use mongodb::bson::{doc, Bson};
        const A: &str = "0123456789abcdef0123456789abcdef";
        const B: &str = "fedcba9876543210fedcba9876543210";
        const C: &str = "11112222333344445555666677778888";

        // Whole documents are walked rather than named fields, because a URL
        // reaches a message body, a profile, a room's sound pack, a forum
        // post's image list and an event's cover — and the next field nobody
        // remembers to add here is a file deleted while it is still in use.
        let record = doc! {
            "content": { "body": format!("look /external/{A}/cat.png") },
            "avatar_url": format!("https://chat.example/external/{B}/me.png"),
            "sounds": { "join": format!("/external/{C}/ding.ogg") },
            "image_urls": [
                format!("/external/{A}/cat.png"),
                "https://elsewhere.example/not-ours.png",
            ],
            "unrelated": 42,
        };

        let mut found = std::collections::HashSet::new();
        collect_folders(&Bson::Document(record), &mut found);
        assert_eq!(
            found,
            [A, B, C]
                .iter()
                .map(|f| f.to_string())
                .collect::<std::collections::HashSet<_>>(),
        );
    }

    #[test]
    fn a_document_with_nothing_of_ours_in_it_references_nothing() {
        use mongodb::bson::{doc, Bson};
        let record = doc! {
            "content": { "body": "just some words" },
            "avatar_url": "",
            "count": 3,
            "nested": { "deeper": ["https://example.com/a.png", "/external/"] },
        };
        let mut found = std::collections::HashSet::new();
        collect_folders(&Bson::Document(record), &mut found);
        assert!(found.is_empty());
    }

    #[test]
    fn an_upload_folder_is_the_only_thing_a_delete_is_pointed_at() {
        const A: &str = "0123456789abcdef0123456789abcdef";
        // This path is handed to a recursive delete, and the difference
        // between `external/<folder>` and `external` is every upload here.
        assert_eq!(
            upload_folder_path(&format!("external/{A}/cat.png")),
            Some(std::path::PathBuf::from(format!("external/{A}"))),
        );
        assert_eq!(upload_folder_path("external/cat.png"), None);
        assert_eq!(upload_folder_path("cat.png"), None);
        assert_eq!(upload_folder_path("external/uploads/u1/cat.png"), None);
        assert_eq!(upload_folder_path(&format!("external/{A}")), None);
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
