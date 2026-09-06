//! Reading the moderation log, and taking a backup of the server.
//!
//! Both answer the same question from different ends: what has happened here,
//! and can I take it with me. Neither existed, which are the two things that
//! make people unwilling to depend on a self-hosted server.

use super::super::{
    audit::AuditEntry,
    helpers::{
        error_response, extract_token, get_user_from_token, is_moderator_or_owner, regex_escape,
    },
    state::AppState,
};
use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Json, Response},
};
use futures_util::TryStreamExt;
use mongodb::bson::{doc, Document};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

const DEFAULT_LIMIT: i64 = 50;
const MAX_LIMIT: i64 = 200;

#[derive(Deserialize)]
pub(crate) struct AuditQuery {
    pub(crate) limit: Option<i64>,
    pub(crate) offset: Option<u64>,
    /// Restrict to one action, or to a prefix like "member" for all of them.
    pub(crate) action: Option<String>,
}

/// The room's moderation log, newest first.
///
/// Restricted to owners and moderators: it names who did what, which is
/// exactly the information a member should not be able to browse for its own
/// sake, and exactly what the people responsible for a room need.
pub(crate) async fn list_audit_log(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuditQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    if !is_moderator_or_owner(&state, &room_id, &user_id).await {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "Only owners and moderators can read the audit log",
        ));
    }

    let limit = query.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let offset = query.offset.unwrap_or(0);

    let mut filter = doc! { "room_id": &room_id };
    if let Some(ref action) = query.action {
        if !action.is_empty() {
            // "member" matches every member.* action; an exact name matches one.
            filter.insert(
                "action",
                doc! { "$regex": format!("^{}", regex_escape(action)) },
            );
        }
    }

    let coll = state.db.collection::<AuditEntry>("audit_log");
    let total = coll.count_documents(filter.clone()).await.unwrap_or(0);

    let mut items: Vec<Value> = Vec::new();
    if let Ok(mut cursor) = coll
        .find(filter)
        .sort(doc! { "created_at": -1 })
        .skip(offset)
        .limit(limit)
        .await
    {
        while let Ok(Some(entry)) = cursor.try_next().await {
            items.push(json!({
                "entry_id": entry.entry_id,
                "actor_id": entry.actor_id,
                "action": entry.action,
                "target_id": entry.target_id,
                "detail": entry.detail,
                "created_at": entry.created_at,
            }));
        }
    }

    let next_offset = offset + items.len() as u64;
    Ok(Json(json!({
        "items": items,
        "has_more": next_offset < total,
        "next_offset": next_offset,
    })))
}

// ─── Backup ──────────────────────────────────────────────────────────────────

/// Collections written to the export, in an order that restores cleanly:
/// the things other things refer to come first.
///
/// `refresh_tokens` is deliberately absent — those are live session material,
/// they expire on their own, and restoring them would resurrect sessions that
/// should have died with the old instance.
const EXPORTED: [&str; 17] = [
    "server_settings",
    "users",
    "rooms",
    "room_members",
    "channels",
    "channel_categories",
    "custom_roles",
    "member_custom_roles",
    "banned_users",
    "messages",
    "reactions",
    "pins",
    "read_markers",
    "notification_settings",
    "forum_posts",
    "invites",
    "audit_log",
];

/// A complete logical backup of the database, as newline-delimited JSON.
///
/// One object per line, each `{"collection": ..., "doc": ...}`, streamed
/// rather than assembled — a server with a real history has more messages than
/// belong in one buffer.
///
/// This **contains password hashes, TOTP secrets and recovery codes**, because
/// a backup that cannot restore anyone's ability to log in is not a backup.
/// That is also why it is admin-only. Uploaded media is not here: it lives on
/// disk in `external/` and has to be copied alongside this file.
pub(crate) async fn admin_export(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Response, (StatusCode, Json<Value>)> {
    super::super::helpers::require_admin(&state, &headers).await?;

    // Streamed through a channel rather than assembled: a server with a real
    // history has more messages than belong in one buffer. Lines are Strings,
    // which Body::from_stream accepts, so this needs no extra crate.
    let db = state.db.clone();
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<String, std::io::Error>>(64);

    tokio::spawn(async move {
        // A header line, so a restore can check what it is looking at before
        // it starts writing.
        let meta = json!({
            "collection": "_meta",
            "doc": {
                "format": "chatter-export-v1",
                "exported_at": super::super::helpers::now_millis(),
                "note": "Uploaded media is not included; copy the external/ directory alongside this file.",
            },
        });
        if tx.send(Ok(format!("{meta}\n"))).await.is_err() {
            return;
        }

        for name in EXPORTED {
            let Ok(mut cursor) = db.collection::<Document>(name).find(doc! {}).await else {
                continue;
            };
            while let Ok(Some(document)) = cursor.try_next().await {
                let Ok(value) = serde_json::to_value(&document) else {
                    continue;
                };
                let line = json!({ "collection": name, "doc": value });
                // The receiver going away means the client hung up mid-export;
                // there is nothing left to write to.
                if tx.send(Ok(format!("{line}\n"))).await.is_err() {
                    return;
                }
            }
        }
    });

    let stream = futures_util::stream::unfold(rx, |mut rx| async move {
        rx.recv().await.map(|line| (line, rx))
    });

    Ok((
        [
            (header::CONTENT_TYPE, "application/x-ndjson"),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=\"chatter-export.ndjson\"",
            ),
        ],
        Body::from_stream(stream),
    )
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_material_is_not_exported() {
        // Restoring live refresh tokens would resurrect sessions that should
        // have died with the old instance.
        assert!(!EXPORTED.contains(&"refresh_tokens"));
    }

    #[test]
    fn the_export_covers_what_a_restore_needs() {
        for required in ["users", "rooms", "room_members", "channels", "messages"] {
            assert!(EXPORTED.contains(&required), "{required} is missing");
        }
    }
}
