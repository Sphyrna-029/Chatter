use super::super::{
    dto::CreateWebhookRequest,
    helpers::{broadcast_to_room, error_response, extract_token, generate_id, get_user_from_token, now_millis},
    state::{AppState, RoomRecord, WebhookRecord},
};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::Json,
};
use futures_util::TryStreamExt;
use mongodb::bson::doc;
use serde_json::{json, Value};
use std::sync::Arc;

pub(crate) async fn create_webhook(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<CreateWebhookRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let rooms_coll = state.db.collection::<RoomRecord>("rooms");
    let room = rooms_coll
        .find_one(doc! { "_id": &room_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Room not found"))?;

    if room.creator != user_id {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "Only the room owner can create webhooks",
        ));
    }

    let name = body.name.trim().to_string();
    if name.is_empty() || name.len() > 64 {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "Webhook name must be 1-64 characters",
        ));
    }

    let webhook_id = generate_id("whk");
    let record = WebhookRecord {
        webhook_id: webhook_id.clone(),
        room_id: room_id.clone(),
        creator: user_id,
        name,
        avatar_url: body.avatar_url.unwrap_or_default(),
        channel_id: body.channel_id.unwrap_or_default(),
        created_at: now_millis(),
    };

    let coll = state.db.collection::<WebhookRecord>("webhooks");
    let _ = coll.insert_one(record).await;

    Ok(Json(json!({
        "webhook_id": webhook_id,
        "url": format!("/api/webhooks/{}", webhook_id),
    })))
}

pub(crate) async fn list_webhooks(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let rooms_coll = state.db.collection::<RoomRecord>("rooms");
    let room = rooms_coll
        .find_one(doc! { "_id": &room_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Room not found"))?;

    if room.creator != user_id {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "Only the room owner can list webhooks",
        ));
    }

    let coll = state.db.collection::<WebhookRecord>("webhooks");
    let mut list: Vec<Value> = Vec::new();

    if let Ok(mut cursor) = coll.find(doc! { "room_id": &room_id }).await {
        while let Ok(Some(wh)) = cursor.try_next().await {
            list.push(json!({
                "webhook_id": wh.webhook_id,
                "name": wh.name,
                "avatar_url": wh.avatar_url,
                "channel_id": wh.channel_id,
                "created_at": wh.created_at,
                "url": format!("/api/webhooks/{}", wh.webhook_id),
            }));
        }
    }

    Ok(Json(json!({ "webhooks": list })))
}

pub(crate) async fn delete_webhook(
    State(state): State<Arc<AppState>>,
    Path(webhook_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let coll = state.db.collection::<WebhookRecord>("webhooks");
    let webhook = coll
        .find_one(doc! { "_id": &webhook_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Webhook not found"))?;

    let rooms_coll = state.db.collection::<RoomRecord>("rooms");
    let room = rooms_coll
        .find_one(doc! { "_id": &webhook.room_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Room not found"))?;

    if room.creator != user_id {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "Only the room owner can delete webhooks",
        ));
    }

    let _ = coll.delete_one(doc! { "_id": &webhook_id }).await;

    Ok(Json(json!({ "success": true })))
}

fn format_github_event(event_type: &str, payload: &Value) -> String {
    match event_type {
        "ping" => {
            let zen = payload["zen"].as_str().unwrap_or("connected");
            format!("GitHub webhook connected: {zen}")
        }
        "push" => {
            let pusher = payload["pusher"]["name"].as_str().unwrap_or("unknown");
            let full_ref = payload["ref"].as_str().unwrap_or("unknown");
            let branch = full_ref.strip_prefix("refs/heads/").unwrap_or(full_ref);
            let commits = payload["commits"].as_array();
            let count = commits.map_or(0, |c| c.len());
            let mut msg = format!("**{pusher}** pushed {count} commit(s) to `{branch}`:");
            if let Some(commits) = commits {
                for c in commits.iter().take(5) {
                    let m = c["message"].as_str().unwrap_or("");
                    let first_line = m.lines().next().unwrap_or("");
                    let truncated = if first_line.len() > 72 {
                        format!("{}...", &first_line[..72])
                    } else {
                        first_line.to_string()
                    };
                    msg.push_str(&format!("\n• {truncated}"));
                }
                if count > 5 {
                    msg.push_str(&format!("\n• ...and {} more", count - 5));
                }
            }
            msg
        }
        "pull_request" => {
            let user = payload["sender"]["login"].as_str().unwrap_or("unknown");
            let action = payload["action"].as_str().unwrap_or("updated");
            let pr = &payload["pull_request"];
            let number = pr["number"].as_u64().unwrap_or(0);
            let title = pr["title"].as_str().unwrap_or("");
            let url = pr["html_url"].as_str().unwrap_or("");
            format!("**{user}** {action} PR **#{number}**: {title} ({url})")
        }
        "issues" => {
            let user = payload["sender"]["login"].as_str().unwrap_or("unknown");
            let action = payload["action"].as_str().unwrap_or("updated");
            let issue = &payload["issue"];
            let number = issue["number"].as_u64().unwrap_or(0);
            let title = issue["title"].as_str().unwrap_or("");
            let url = issue["html_url"].as_str().unwrap_or("");
            format!("**{user}** {action} issue **#{number}**: {title} ({url})")
        }
        "issue_comment" => {
            let user = payload["sender"]["login"].as_str().unwrap_or("unknown");
            let issue = &payload["issue"];
            let number = issue["number"].as_u64().unwrap_or(0);
            let title = issue["title"].as_str().unwrap_or("");
            let url = issue["html_url"].as_str().unwrap_or("");
            format!("**{user}** commented on issue **#{number}**: {title} ({url})")
        }
        "create" => {
            let user = payload["sender"]["login"].as_str().unwrap_or("unknown");
            let ref_type = payload["ref_type"].as_str().unwrap_or("ref");
            let ref_name = payload["ref"].as_str().unwrap_or("unknown");
            format!("**{user}** created {ref_type} `{ref_name}`")
        }
        "delete" => {
            let user = payload["sender"]["login"].as_str().unwrap_or("unknown");
            let ref_type = payload["ref_type"].as_str().unwrap_or("ref");
            let ref_name = payload["ref"].as_str().unwrap_or("unknown");
            format!("**{user}** deleted {ref_type} `{ref_name}`")
        }
        "star" => {
            let user = payload["sender"]["login"].as_str().unwrap_or("unknown");
            format!("**{user}** starred the repository")
        }
        "release" => {
            let user = payload["sender"]["login"].as_str().unwrap_or("unknown");
            let action = payload["action"].as_str().unwrap_or("published");
            let release = &payload["release"];
            let tag = release["tag_name"].as_str().unwrap_or("");
            let name = release["name"].as_str().unwrap_or(tag);
            let url = release["html_url"].as_str().unwrap_or("");
            format!("**{user}** {action} release **{tag}**: {name} ({url})")
        }
        "fork" => {
            let user = payload["sender"]["login"].as_str().unwrap_or("unknown");
            format!("**{user}** forked the repository")
        }
        _ => format!("GitHub event: {event_type}"),
    }
}

pub(crate) async fn execute_webhook(
    State(state): State<Arc<AppState>>,
    Path(webhook_id): Path<String>,
    headers: HeaderMap,
    body: String,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let text = if let Some(event_type) = headers.get("X-GitHub-Event") {
        let event_type = event_type.to_str().unwrap_or("unknown");
        let payload: Value = serde_json::from_str(&body)
            .map_err(|_| error_response(StatusCode::BAD_REQUEST, "Invalid JSON body"))?;
        format_github_event(event_type, &payload)
    } else {
        let payload: Value = serde_json::from_str(&body)
            .map_err(|_| error_response(StatusCode::BAD_REQUEST, "Invalid JSON body"))?;
        let text = payload["content"]
            .as_str()
            .or_else(|| payload["text"].as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        text
    };

    if text.is_empty() {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "Message content is required",
        ));
    }
    if text.len() > 4000 {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "Message too long (max 4000 characters)",
        ));
    }

    let coll = state.db.collection::<WebhookRecord>("webhooks");
    let webhook = coll
        .find_one(doc! { "_id": &webhook_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Webhook not found"))?;

    let event_id = generate_id("$");
    let ts = now_millis();
    let sender = format!("webhook:{}", webhook_id);

    let mut event = json!({
        "type": "m.room.message",
        "room_id": webhook.room_id,
        "sender": sender,
        "content": {
            "msgtype": "m.text",
            "body": text,
            "webhook": true,
            "webhook_name": webhook.name,
            "webhook_avatar_url": webhook.avatar_url,
        },
        "event_id": event_id,
        "origin_server_ts": ts,
    });

    // Route to configured channel if set
    if !webhook.channel_id.is_empty() {
        event["channel_id"] = json!(webhook.channel_id);
    }

    // Store in MongoDB
    let msg_coll = state.db.collection::<mongodb::bson::Document>("messages");
    if let Ok(doc) = mongodb::bson::to_document(&event) {
        let _ = msg_coll.insert_one(doc).await;
    }

    broadcast_to_room(&state, &webhook.room_id, &event).await;

    Ok(Json(json!({ "event_id": event_id })))
}
