use super::super::{
    dto::{CreateChannelRequest, UpdateChannelRequest, CreateCategoryRequest, UpdateCategoryRequest},
    helpers::{
        broadcast_to_room, error_response, extract_token, generate_id, get_user_role,
        get_user_from_token, now_millis, get_user_custom_role_ids,
    },
    state::{AppState, ChannelRecord, ChannelCategoryRecord, RoomRecord},
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

pub(crate) async fn list_channels(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    // Check membership
    {
        let rm = state.room_members.read().await;
        if !rm.get(&room_id).map(|m| m.contains(&user_id)).unwrap_or(false) {
            return Err(error_response(StatusCode::FORBIDDEN, "Not a member of this room"));
        }
    }

    let channels_coll = state.db.collection::<ChannelRecord>("channels");
    let mut cursor = channels_coll
        .find(doc! { "room_id": &room_id })
        .sort(doc! { "position": 1, "created_at": 1 })
        .await
        .map_err(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "DB query failed"))?;

    let role = get_user_role(&state, &room_id, &user_id).await;
    let is_privileged = role == "owner" || role == "moderator";
    let user_custom_roles = get_user_custom_role_ids(&state, &room_id, &user_id).await;

    let mut channels: Vec<Value> = Vec::new();
    while let Ok(Some(ch)) = cursor.try_next().await {
        // Filter by view_roles: if non-empty, only privileged users or users with a matching role can see it
        if !ch.view_roles.is_empty() && !is_privileged {
            if !ch.view_roles.iter().any(|r| user_custom_roles.contains(r)) {
                continue;
            }
        }
        channels.push(json!({
            "channel_id": ch.channel_id,
            "room_id": ch.room_id,
            "name": ch.name,
            "channel_type": ch.channel_type,
            "topic": ch.topic,
            "position": ch.position,
            "category_id": ch.category_id,
            "read_only": ch.read_only,
            "view_roles": ch.view_roles,
            "write_roles": ch.write_roles,
            "showcase_write_roles": ch.showcase_write_roles,
            "showcase_posters": ch.showcase_posters,
            "system_channel": ch.system_channel,
            "created_by": ch.created_by,
            "created_at": ch.created_at,
        }));
    }

    // Also fetch categories
    let categories_coll = state.db.collection::<ChannelCategoryRecord>("channel_categories");
    let mut cat_cursor = categories_coll
        .find(doc! { "room_id": &room_id })
        .sort(doc! { "position": 1, "created_at": 1 })
        .await
        .map_err(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "DB query failed"))?;
    let mut categories: Vec<Value> = Vec::new();
    while let Ok(Some(cat)) = cat_cursor.try_next().await {
        categories.push(json!({
            "category_id": cat.category_id,
            "name": cat.name,
            "position": cat.position,
        }));
    }

    Ok(Json(json!({ "channels": channels, "categories": categories })))
}

pub(crate) async fn create_channel(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
    Json(req): Json<CreateChannelRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    // Check room exists and is not a DM
    let rooms_coll = state.db.collection::<RoomRecord>("rooms");
    let room = rooms_coll
        .find_one(doc! { "_id": &room_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Room not found"))?;

    if room.is_dm {
        return Err(error_response(StatusCode::BAD_REQUEST, "Cannot create channels in DMs"));
    }

    // Permission check: owner or moderator
    let role = get_user_role(&state, &room_id, &user_id).await;
    if role != "owner" && role != "moderator" {
        return Err(error_response(StatusCode::FORBIDDEN, "Only owners and moderators can create channels"));
    }

    // Validate
    let name: String = req.name.trim().chars().take(30).collect();
    if name.is_empty() {
        return Err(error_response(StatusCode::BAD_REQUEST, "Channel name cannot be empty"));
    }
    let valid_channel_types = ["text", "voice", "theater", "forum", "whiteboard", "showcase"];
    if !valid_channel_types.contains(&req.channel_type.as_str()) {
        return Err(error_response(StatusCode::BAD_REQUEST, "Invalid channel type"));
    }

    // Get next position
    let channels_coll = state.db.collection::<ChannelRecord>("channels");
    let max_pos = channels_coll
        .count_documents(doc! { "room_id": &room_id })
        .await
        .unwrap_or(0) as i32;

    let channel_id = generate_id("#");
    let channel = ChannelRecord {
        channel_id: channel_id.clone(),
        room_id: room_id.clone(),
        name: name.clone(),
        channel_type: req.channel_type.clone(),
        topic: req.topic.unwrap_or_default(),
        position: max_pos,
        category_id: req.category_id.unwrap_or_default(),
        read_only: false,
        view_roles: vec![],
        write_roles: vec![],
        showcase_write_roles: vec![],
        showcase_posters: vec![],
        system_channel: false,
        created_by: user_id.clone(),
        created_at: now_millis(),
    };

    let _ = channels_coll.insert_one(&channel).await;

    let event = json!({
        "type": "m.channel.created",
        "room_id": room_id,
        "sender": user_id,
        "channel": {
            "channel_id": channel.channel_id,
            "room_id": channel.room_id,
            "name": channel.name,
            "channel_type": channel.channel_type,
            "topic": channel.topic,
            "position": channel.position,
            "category_id": channel.category_id,
            "read_only": channel.read_only,
            "view_roles": channel.view_roles,
            "write_roles": channel.write_roles,
            "showcase_write_roles": channel.showcase_write_roles,
            "showcase_posters": channel.showcase_posters,
            "system_channel": channel.system_channel,
            "created_by": channel.created_by,
            "created_at": channel.created_at,
        }
    });
    broadcast_to_room(&state, &room_id, &event).await;

    Ok(Json(json!({ "channel_id": channel_id })))
}

pub(crate) async fn update_channel(
    State(state): State<Arc<AppState>>,
    Path((room_id, channel_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(req): Json<UpdateChannelRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let role = get_user_role(&state, &room_id, &user_id).await;
    if role != "owner" && role != "moderator" {
        return Err(error_response(StatusCode::FORBIDDEN, "Only owners and moderators can edit channels"));
    }

    let channels_coll = state.db.collection::<ChannelRecord>("channels");
    let _channel = channels_coll
        .find_one(doc! { "_id": &channel_id, "room_id": &room_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Channel not found"))?;

    let mut set_doc = mongodb::bson::Document::new();
    let mut content = serde_json::Map::new();
    content.insert("channel_id".to_string(), json!(channel_id));

    if let Some(ref name) = req.name {
        let sanitized: String = name.trim().chars().take(30).collect();
        if sanitized.is_empty() {
            return Err(error_response(StatusCode::BAD_REQUEST, "Channel name cannot be empty"));
        }
        set_doc.insert("name", sanitized.as_str());
        content.insert("name".to_string(), json!(sanitized));
    }
    if let Some(ref topic) = req.topic {
        set_doc.insert("topic", topic.as_str());
        content.insert("topic".to_string(), json!(topic));
    }
    if let Some(position) = req.position {
        set_doc.insert("position", position);
        content.insert("position".to_string(), json!(position));
    }
    if let Some(ref category_id) = req.category_id {
        set_doc.insert("category_id", category_id.as_str());
        content.insert("category_id".to_string(), json!(category_id));
    }
    if let Some(read_only) = req.read_only {
        set_doc.insert("read_only", read_only);
        content.insert("read_only".to_string(), json!(read_only));
    }
    if let Some(ref view_roles) = req.view_roles {
        let bson_arr: Vec<mongodb::bson::Bson> = view_roles.iter().map(|s| mongodb::bson::Bson::String(s.clone())).collect();
        set_doc.insert("view_roles", bson_arr);
        content.insert("view_roles".to_string(), json!(view_roles));
    }
    if let Some(ref write_roles) = req.write_roles {
        let bson_arr: Vec<mongodb::bson::Bson> = write_roles.iter().map(|s| mongodb::bson::Bson::String(s.clone())).collect();
        set_doc.insert("write_roles", bson_arr);
        content.insert("write_roles".to_string(), json!(write_roles));
    }
    if let Some(ref showcase_write_roles) = req.showcase_write_roles {
        let bson_arr: Vec<mongodb::bson::Bson> = showcase_write_roles.iter().map(|s| mongodb::bson::Bson::String(s.clone())).collect();
        set_doc.insert("showcase_write_roles", bson_arr);
        content.insert("showcase_write_roles".to_string(), json!(showcase_write_roles));
    }
    if let Some(ref showcase_posters) = req.showcase_posters {
        let bson_arr: Vec<mongodb::bson::Bson> = showcase_posters.iter().map(|s| mongodb::bson::Bson::String(s.clone())).collect();
        set_doc.insert("showcase_posters", bson_arr);
        content.insert("showcase_posters".to_string(), json!(showcase_posters));
    }
    if let Some(system_channel) = req.system_channel {
        // If enabling, clear any other system channel in this room first
        if system_channel {
            let _ = channels_coll
                .update_many(
                    doc! { "room_id": &room_id, "system_channel": true },
                    doc! { "$set": { "system_channel": false } },
                )
                .await;
        }
        set_doc.insert("system_channel", system_channel);
        content.insert("system_channel".to_string(), json!(system_channel));
    }

    if !set_doc.is_empty() {
        let _ = channels_coll
            .update_one(
                doc! { "_id": &channel_id, "room_id": &room_id },
                doc! { "$set": set_doc },
            )
            .await;
    }

    let event = json!({
        "type": "m.channel.updated",
        "room_id": room_id,
        "sender": user_id,
        "content": Value::Object(content)
    });
    broadcast_to_room(&state, &room_id, &event).await;

    Ok(Json(json!({ "updated": true })))
}

pub(crate) async fn delete_channel(
    State(state): State<Arc<AppState>>,
    Path((room_id, channel_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let role = get_user_role(&state, &room_id, &user_id).await;
    if role != "owner" && role != "moderator" {
        return Err(error_response(StatusCode::FORBIDDEN, "Only owners and moderators can delete channels"));
    }

    let channels_coll = state.db.collection::<ChannelRecord>("channels");
    let channel = channels_coll
        .find_one(doc! { "_id": &channel_id, "room_id": &room_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Channel not found"))?;

    // Check it's not the last text channel
    if channel.channel_type == "text" {
        let text_count = channels_coll
            .count_documents(doc! { "room_id": &room_id, "channel_type": "text" })
            .await
            .unwrap_or(0);
        if text_count <= 1 {
            return Err(error_response(StatusCode::BAD_REQUEST, "Cannot delete the last text channel"));
        }
    }

    let _ = channels_coll.delete_one(doc! { "_id": &channel_id }).await;

    // Remove voice channel state for this channel
    {
        let mut vc = state.voice_channels.write().await;
        vc.remove(&channel_id);
    }

    let event = json!({
        "type": "m.channel.deleted",
        "room_id": room_id,
        "sender": user_id,
        "channel_id": channel_id,
    });
    broadcast_to_room(&state, &room_id, &event).await;

    Ok(Json(json!({ "deleted": true })))
}

/// Ensure a room has at least one text channel.  Returns the default channel_id.
pub(crate) async fn ensure_default_channels(state: &AppState, room_id: &str, creator: &str) -> String {
    let channels_coll = state.db.collection::<ChannelRecord>("channels");
    let count = channels_coll
        .count_documents(doc! { "room_id": room_id })
        .await
        .unwrap_or(0);

    if count > 0 {
        // Return first text channel
        if let Ok(Some(ch)) = channels_coll
            .find_one(doc! { "room_id": room_id, "channel_type": "text" })
            .await
        {
            return ch.channel_id;
        }
    }

    // Create default text channel
    let text_id = generate_id("#");
    let _ = channels_coll
        .insert_one(ChannelRecord {
            channel_id: text_id.clone(),
            room_id: room_id.to_string(),
            name: "general".to_string(),
            channel_type: "text".to_string(),
            topic: String::new(),
            position: 0,
            category_id: String::new(),
            read_only: false,
            view_roles: vec![],
            write_roles: vec![],
            showcase_write_roles: vec![],
            showcase_posters: vec![],
            system_channel: false,
            created_by: creator.to_string(),
            created_at: now_millis(),
        })
        .await;

    // Create default voice channel
    let voice_id = generate_id("#");
    let _ = channels_coll
        .insert_one(ChannelRecord {
            channel_id: voice_id,
            room_id: room_id.to_string(),
            name: "General".to_string(),
            channel_type: "voice".to_string(),
            topic: String::new(),
            position: 1,
            category_id: String::new(),
            read_only: false,
            view_roles: vec![],
            write_roles: vec![],
            showcase_write_roles: vec![],
            showcase_posters: vec![],
            system_channel: false,
            created_by: creator.to_string(),
            created_at: now_millis(),
        })
        .await;

    text_id
}

// ─── Channel Categories ─────────────────────────────────────────────────────

pub(crate) async fn create_category(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
    Json(req): Json<CreateCategoryRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let role = get_user_role(&state, &room_id, &user_id).await;
    if role != "owner" && role != "moderator" {
        return Err(error_response(StatusCode::FORBIDDEN, "Only owners and moderators can create categories"));
    }

    let name: String = req.name.trim().chars().take(30).collect();
    if name.is_empty() {
        return Err(error_response(StatusCode::BAD_REQUEST, "Category name cannot be empty"));
    }

    let categories_coll = state.db.collection::<ChannelCategoryRecord>("channel_categories");
    let max_pos = categories_coll
        .count_documents(doc! { "room_id": &room_id })
        .await
        .unwrap_or(0) as i32;

    let category_id = generate_id("cat_");
    let category = ChannelCategoryRecord {
        category_id: category_id.clone(),
        room_id: room_id.clone(),
        name: name.clone(),
        position: max_pos,
        created_by: user_id.clone(),
        created_at: now_millis(),
    };

    let _ = categories_coll.insert_one(&category).await;

    let event = json!({
        "type": "m.channel.category_created",
        "room_id": room_id,
        "sender": user_id,
        "category": {
            "category_id": category.category_id,
            "name": category.name,
            "position": category.position,
        }
    });
    broadcast_to_room(&state, &room_id, &event).await;

    Ok(Json(json!({ "category_id": category_id })))
}

pub(crate) async fn update_category(
    State(state): State<Arc<AppState>>,
    Path((room_id, category_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(req): Json<UpdateCategoryRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let role = get_user_role(&state, &room_id, &user_id).await;
    if role != "owner" && role != "moderator" {
        return Err(error_response(StatusCode::FORBIDDEN, "Only owners and moderators can edit categories"));
    }

    let categories_coll = state.db.collection::<ChannelCategoryRecord>("channel_categories");
    let _cat = categories_coll
        .find_one(doc! { "_id": &category_id, "room_id": &room_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Category not found"))?;

    let mut set_doc = mongodb::bson::Document::new();
    let mut content = serde_json::Map::new();
    content.insert("category_id".to_string(), json!(category_id));

    if let Some(ref name) = req.name {
        let sanitized: String = name.trim().chars().take(30).collect();
        if sanitized.is_empty() {
            return Err(error_response(StatusCode::BAD_REQUEST, "Category name cannot be empty"));
        }
        set_doc.insert("name", sanitized.as_str());
        content.insert("name".to_string(), json!(sanitized));
    }
    if let Some(position) = req.position {
        set_doc.insert("position", position);
        content.insert("position".to_string(), json!(position));
    }

    if !set_doc.is_empty() {
        let _ = categories_coll
            .update_one(
                doc! { "_id": &category_id, "room_id": &room_id },
                doc! { "$set": set_doc },
            )
            .await;
    }

    let event = json!({
        "type": "m.channel.category_updated",
        "room_id": room_id,
        "sender": user_id,
        "content": Value::Object(content)
    });
    broadcast_to_room(&state, &room_id, &event).await;

    Ok(Json(json!({ "updated": true })))
}

pub(crate) async fn delete_category(
    State(state): State<Arc<AppState>>,
    Path((room_id, category_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let role = get_user_role(&state, &room_id, &user_id).await;
    if role != "owner" && role != "moderator" {
        return Err(error_response(StatusCode::FORBIDDEN, "Only owners and moderators can delete categories"));
    }

    let categories_coll = state.db.collection::<ChannelCategoryRecord>("channel_categories");
    let _ = categories_coll.delete_one(doc! { "_id": &category_id, "room_id": &room_id }).await;

    // Unset category_id on channels that belonged to this category
    let channels_coll = state.db.collection::<ChannelRecord>("channels");
    let _ = channels_coll
        .update_many(
            doc! { "room_id": &room_id, "category_id": &category_id },
            doc! { "$set": { "category_id": "" } },
        )
        .await;

    let event = json!({
        "type": "m.channel.category_deleted",
        "room_id": room_id,
        "sender": user_id,
        "category_id": category_id,
    });
    broadcast_to_room(&state, &room_id, &event).await;

    Ok(Json(json!({ "deleted": true })))
}
