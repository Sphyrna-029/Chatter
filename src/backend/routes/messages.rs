use super::super::{
    audit,
    dto::{
        EditMessageRequest, MessagesQuery, SearchQuery, SendMessageRequest, SetThreadNameRequest,
        ThreadListQuery,
    },
    helpers::{
        broadcast_to_room, can_manage_messages, channel_permissions, effective_permissions,
        error_response, extract_token, generate_id, get_allowed_channel_ids, get_bot_from_token,
        get_reactions_for_events, get_thread_counts_for_events, get_user_custom_role_ids,
        get_user_from_token, get_user_role, is_moderator_or_owner, now_millis, rate_limited,
        regex_escape, send_to_user,
    },
    push::{spawn_message_push, MessageNotification},
    ratelimit,
    state::{AppState, ChannelRecord, DmRoomRecord, DmStreakRecord, RoomRecord, UserRecord},
};
use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::Json,
};
use futures_util::TryStreamExt;
use mongodb::bson::doc;
use regex::Regex;
use serde_json::{json, Value};
use std::sync::Arc;

/// Whether a message body carries a file served by this instance. Attachments
/// are sent as `/external/...` URLs in the body, so that is where the
/// attach_files permission has to be judged.
fn body_has_attachment(body: &str) -> bool {
    body.split_whitespace()
        .any(|token| token.starts_with("/external/") || token.contains("/external/"))
}

/// The name a notification should call this sender, falling back to the user id
/// when no display name has been set.
async fn display_name_for(state: &AppState, user_id: &str) -> String {
    let name = state
        .db
        .collection::<UserRecord>("users")
        .find_one(doc! { "_id": user_id })
        .await
        .ok()
        .flatten()
        .map(|u| u.display_name)
        .unwrap_or_default();
    if !name.is_empty() {
        return name;
    }
    user_id
        .split(':')
        .next()
        .unwrap_or(user_id)
        .trim_start_matches('@')
        .to_string()
}

pub(crate) async fn send_message(
    State(state): State<Arc<AppState>>,
    Path((room_id, txn_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(req): Json<SendMessageRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let _ = txn_id;
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;

    // Try JWT first (stateless, fast), then fall back to bot token (DB lookup)
    let user_id_opt = get_user_from_token(&state, &token);
    let bot_record = if user_id_opt.is_none() {
        get_bot_from_token(&state, &token).await
    } else {
        None
    };

    let is_bot = bot_record.is_some();
    let (sender_id, bot_name, bot_avatar_url) = if let Some(ref bot) = bot_record {
        (
            format!("bot:{}", bot.bot_id),
            Some(bot.name.clone()),
            Some(bot.avatar_url.clone()),
        )
    } else if let Some(uid) = user_id_opt {
        (uid, None, None)
    } else {
        return Err(error_response(StatusCode::UNAUTHORIZED, "Invalid token"));
    };

    let rooms_coll = state.db.collection::<RoomRecord>("rooms");
    let room = rooms_coll
        .find_one(doc! { "_id": &room_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Room not found"))?;

    if is_bot {
        // Bots must target their own room and a channel with matching bot_id
        let bot = bot_record.as_ref().unwrap();
        if bot.room_id != room_id {
            return Err(error_response(
                StatusCode::FORBIDDEN,
                "Bot does not belong to this room",
            ));
        }
    } else {
        // Regular user: check room membership
        {
            let rm = state.room_members.read().await;
            if !rm
                .get(&room_id)
                .map(|m| m.contains(&sender_id))
                .unwrap_or(false)
            {
                return Err(error_response(
                    StatusCode::FORBIDDEN,
                    "Not a member of this room",
                ));
            }
        }

        let perms = effective_permissions(&state, &room_id, &sender_id).await;
        if !perms.send_messages {
            return Err(error_response(
                StatusCode::FORBIDDEN,
                "You do not have permission to send messages in this room",
            ));
        }
        if !perms.attach_files && body_has_attachment(&req.body) {
            return Err(error_response(
                StatusCode::FORBIDDEN,
                "You do not have permission to attach files in this room",
            ));
        }
        if !perms.embed_links && req.embeds.as_ref().is_some_and(|e| !e.is_empty()) {
            return Err(error_response(
                StatusCode::FORBIDDEN,
                "You do not have permission to post embeds in this room",
            ));
        }

        if room.read_only {
            let role = get_user_role(&state, &room_id, &sender_id).await;
            if role != "owner" && role != "moderator" {
                return Err(error_response(
                    StatusCode::FORBIDDEN,
                    "This room is read-only",
                ));
            }
        }
    }

    const MAX_MESSAGE_LENGTH: usize = 4000;
    let msgtype = req.msgtype.as_deref().unwrap_or("m.text");
    // Count display length: each :emoji{url}: marker counts as 1 character
    let emoji_marker = regex::Regex::new(r":emoji\{[^}]+\}:").unwrap();
    let display_body = emoji_marker.replace_all(&req.body, "X");
    if msgtype == "m.text" && display_body.len() > MAX_MESSAGE_LENGTH {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "Message exceeds maximum length of 4000 characters",
        ));
    }

    // Resolve channel_id: use provided or fall back to default text channel
    let channel_id = if let Some(cid) = req.channel_id.as_deref() {
        cid.to_string()
    } else if !room.is_dm {
        // Find the default (first) text channel
        use super::channels::ensure_default_channels;
        ensure_default_channels(&state, &room_id, &sender_id).await
    } else {
        String::new()
    };

    // Check per-channel permissions
    if !channel_id.is_empty() {
        let channels_coll = state.db.collection::<ChannelRecord>("channels");
        if let Ok(Some(ch)) = channels_coll
            .find_one(mongodb::bson::doc! { "_id": &channel_id })
            .await
        {
            if is_bot {
                // Bots can only send in their own bot channels
                let bot = bot_record.as_ref().unwrap();
                if ch.bot_id != bot.bot_id {
                    return Err(error_response(
                        StatusCode::FORBIDDEN,
                        "Bot can only send messages in its own channels",
                    ));
                }
            } else {
                let role = get_user_role(&state, &room_id, &sender_id).await;
                let is_privileged = role == "owner" || role == "moderator";

                if ch.read_only && !is_privileged {
                    return Err(error_response(
                        StatusCode::FORBIDDEN,
                        "This channel is read-only",
                    ));
                }

                // Channel overwrites decide access from here: a member must be
                // able to see the channel to post in it, and must still hold
                // send_messages after the channel's own rules are applied.
                let ch_perms = channel_permissions(&state, &room_id, &channel_id, &sender_id).await;
                if !ch_perms.view_channel {
                    return Err(error_response(
                        StatusCode::FORBIDDEN,
                        "You do not have access to this channel",
                    ));
                }
                if !ch_perms.send_messages {
                    return Err(error_response(
                        StatusCode::FORBIDDEN,
                        "You do not have permission to send messages in this channel",
                    ));
                }
                if !ch_perms.attach_files && body_has_attachment(&req.body) {
                    return Err(error_response(
                        StatusCode::FORBIDDEN,
                        "You do not have permission to attach files in this channel",
                    ));
                }

                // For showcase channels, enforce featured pane write restrictions
                if ch.channel_type == "showcase"
                    && req.showcase_pane.as_deref() == Some("featured")
                    && !is_privileged
                {
                    if ch.showcase_write_roles.is_empty() {
                        return Err(error_response(
                            StatusCode::FORBIDDEN,
                            "Only owners and moderators can post in the featured pane",
                        ));
                    }
                    let user_roles = get_user_custom_role_ids(&state, &room_id, &sender_id).await;
                    if !ch
                        .showcase_write_roles
                        .iter()
                        .any(|r| user_roles.contains(r))
                    {
                        return Err(error_response(
                            StatusCode::FORBIDDEN,
                            "You do not have permission to post in the featured pane",
                        ));
                    }
                }
            }
        }
    }

    // Bots are rate limited on their own identity, so one misbehaving bot
    // cannot spend a person's budget or vice versa.
    if let Err(retry_after) = ratelimit::check(
        &state,
        &format!("send:{sender_id}"),
        ratelimit::SEND_MESSAGE,
    )
    .await
    {
        return Err(rate_limited(
            retry_after,
            "You are sending messages too quickly",
        ));
    }

    // Slowmode, where the channel sets one. Bypassed by anyone who can manage
    // messages — the same people read_only lets through.
    if !channel_id.is_empty() && !is_bot {
        let slowmode = state
            .db
            .collection::<ChannelRecord>("channels")
            .find_one(doc! { "_id": &channel_id })
            .await
            .ok()
            .flatten()
            .map(|ch| ch.slowmode_secs)
            .unwrap_or(0);
        if slowmode > 0 && !can_manage_messages(&state, &room_id, &sender_id).await {
            if let Err(retry_after) =
                ratelimit::check_slowmode(&state, &channel_id, &sender_id, slowmode).await
            {
                return Err(rate_limited(retry_after, "This channel is in slow mode"));
            }
        }
    }

    let event_id = generate_id("$");
    let timestamp = now_millis();

    let mut content = json!({
        "msgtype": req.msgtype.unwrap_or_else(|| "m.text".to_string()),
        "body": req.body
    });

    if req.spoiler == Some(true) {
        content["spoiler"] = json!(true);
    }

    // Without mention_everyone the message still sends and still reads as
    // written — it just does not ping. Rejecting it outright would be a worse
    // trade than quietly declawing the mention.
    if !is_bot {
        let perms = effective_permissions(&state, &room_id, &sender_id).await;
        if !perms.mention_everyone {
            content["suppress_role_mentions"] = json!(true);
        }
    }

    if let Some(ref pane) = req.showcase_pane {
        content["showcase_pane"] = json!(pane);
    }

    // Bot metadata
    if is_bot {
        content["bot"] = json!(true);
        if let Some(ref name) = bot_name {
            content["bot_name"] = json!(name);
        }
        if let Some(ref url) = bot_avatar_url {
            content["bot_avatar_url"] = json!(url);
        }
    }

    // Rich embeds
    if let Some(ref embeds) = req.embeds {
        if !embeds.is_empty() {
            content["embeds"] = json!(embeds);
        }
    }

    // If replying to a message, look up parent and embed reply metadata
    let mut reply_to_user: Option<String> = None;
    if let Some(ref parent_event_id) = req.in_reply_to {
        content["in_reply_to"] = json!(parent_event_id);

        // Look up parent message from MongoDB
        let msg_coll = state.db.collection::<mongodb::bson::Document>("messages");
        if let Ok(Some(parent)) = msg_coll
            .find_one(doc! { "event_id": parent_event_id, "room_id": &room_id })
            .await
        {
            if let Ok(sender) = parent.get_str("sender") {
                content["reply_to_sender"] = json!(sender);
                reply_to_user = Some(sender.to_string());
            }
            if let Ok(parent_content) = parent.get_document("content") {
                if let Ok(body) = parent_content.get_str("body") {
                    let preview: String = body.chars().take(100).collect();
                    content["reply_to_body"] = json!(preview);
                }
                if parent_content.get_bool("spoiler").unwrap_or(false) {
                    content["reply_to_spoiler"] = json!(true);
                }
            }
        }
    }

    let mut event = json!({
        "type": "m.room.message",
        "room_id": room_id,
        "sender": sender_id,
        "content": content,
        "event_id": event_id,
        "origin_server_ts": timestamp
    });
    if !channel_id.is_empty() {
        event["channel_id"] = json!(channel_id);
    }

    // Store in MongoDB
    let msg_coll = state.db.collection::<mongodb::bson::Document>("messages");
    if let Ok(doc) = mongodb::bson::to_document(&event) {
        let _ = msg_coll.insert_one(doc).await;
    }

    broadcast_to_room(&state, &room_id, &event).await;

    // Anyone connected has just been handed the event and raises their own
    // notification from it; push covers only the members that reached nobody.
    // Read back off the event: `content` was moved into it above.
    let is_system = event
        .get("content")
        .and_then(|c| c.get("msgtype"))
        .and_then(|v| v.as_str())
        == Some("m.system");
    if !is_system {
        let channel_name = if channel_id.is_empty() {
            String::new()
        } else {
            state
                .db
                .collection::<ChannelRecord>("channels")
                .find_one(doc! { "_id": &channel_id })
                .await
                .ok()
                .flatten()
                .map(|ch| ch.name)
                .unwrap_or_default()
        };
        let sender_name = match bot_name {
            Some(ref name) => name.clone(),
            None => display_name_for(&state, &sender_id).await,
        };
        spawn_message_push(
            state.clone(),
            MessageNotification {
                room_id: room_id.clone(),
                channel_id: channel_id.clone(),
                event_id: event_id.clone(),
                sender_id: sender_id.clone(),
                sender_name,
                room_name: room.name.clone(),
                channel_name,
                body: req.body.clone(),
                icon: room.icon_url.clone(),
                is_dm: room.is_dm,
                suppress_role_mentions: event
                    .get("content")
                    .and_then(|c| c.get("suppress_role_mentions"))
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
            },
        );
    }

    // Send reply notification (not for bots)
    if !is_bot {
        if let Some(ref replied_user) = reply_to_user {
            if replied_user != &sender_id {
                let notification = json!({
                    "type": "m.reply_notification",
                    "room_id": room_id,
                    "sender": sender_id,
                    "event_id": event_id,
                    "reply_to_event_id": req.in_reply_to,
                });
                send_to_user(&state, replied_user, &notification).await;
            }
        }
    }

    // Update DM streak on every message sent in a DM room
    if room.is_dm {
        let dm_rooms_coll = state.db.collection::<DmRoomRecord>("dm_rooms");
        if let Ok(Some(dm_record)) = dm_rooms_coll.find_one(doc! { "room_id": &room_id }).await {
            let streak_coll = state.db.collection::<DmStreakRecord>("dm_streaks");
            let today_naive = chrono::Utc::now().date_naive();
            let today_str = today_naive.format("%Y-%m-%d").to_string();

            let new_count: u32;
            if let Ok(Some(existing)) = streak_coll
                .find_one(doc! { "_id": &dm_record.user_pair })
                .await
            {
                let last_naive =
                    chrono::NaiveDate::parse_from_str(&existing.last_streak_date, "%Y-%m-%d")
                        .unwrap_or(today_naive);
                let diff = today_naive.signed_duration_since(last_naive).num_days();
                if diff == 0 {
                    // Same day: just update last_message_ts, streak count unchanged
                    new_count = existing.streak_count;
                    streak_coll
                        .update_one(
                            doc! { "_id": &dm_record.user_pair },
                            doc! { "$set": { "last_message_ts": timestamp } },
                        )
                        .await
                        .ok();
                } else if diff == 1 {
                    // Next consecutive day: increment streak
                    new_count = existing.streak_count + 1;
                    streak_coll
                        .update_one(
                            doc! { "_id": &dm_record.user_pair },
                            doc! { "$set": {
                                "streak_count": new_count,
                                "last_message_ts": timestamp,
                                "last_streak_date": &today_str
                            }},
                        )
                        .await
                        .ok();
                } else {
                    // Streak broken: reset to 1
                    new_count = 1;
                    streak_coll
                        .update_one(
                            doc! { "_id": &dm_record.user_pair },
                            doc! { "$set": {
                                "streak_count": 1u32,
                                "last_message_ts": timestamp,
                                "last_streak_date": &today_str
                            }},
                        )
                        .await
                        .ok();
                }
            } else {
                // No existing streak: start at 1
                new_count = 1;
                let new_record = DmStreakRecord {
                    user_pair: dm_record.user_pair.clone(),
                    streak_count: 1,
                    last_message_ts: timestamp,
                    last_streak_date: today_str,
                };
                streak_coll.insert_one(new_record).await.ok();
            }

            // Broadcast streak update to both DM members
            let streak_event = json!({
                "type": "m.room.dm_streak",
                "room_id": room_id,
                "streak_count": new_count,
                "last_message_ts": timestamp,
            });
            broadcast_to_room(&state, &room_id, &streak_event).await;
        }
    }

    Ok(Json(json!({"event_id": event_id})))
}

/// Combine the visibility filter with a cursor predicate.
///
/// `$and` rather than merging keys: the base filter already carries its own
/// `$or` for channel visibility, and a second `$or` written alongside it would
/// silently replace the first — handing back messages from channels the caller
/// cannot see.
fn and_filter(
    base: &mongodb::bson::Document,
    extra: mongodb::bson::Document,
) -> mongodb::bson::Document {
    if extra.is_empty() {
        return base.clone();
    }
    doc! { "$and": [base.clone(), extra] }
}

/// One page of messages, already stripped of Mongo's `_id`.
async fn fetch_page(
    coll: &mongodb::Collection<mongodb::bson::Document>,
    filter: mongodb::bson::Document,
    sort: mongodb::bson::Document,
    limit: i64,
) -> Result<Vec<Value>, (StatusCode, Json<Value>)> {
    let mut cursor = coll
        .find(filter)
        .sort(sort)
        .limit(limit)
        .await
        .map_err(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "DB query failed"))?;

    let mut out = Vec::new();
    while let Ok(Some(mut doc)) = cursor.try_next().await {
        doc.remove("_id");
        if let Ok(value) = serde_json::to_value(&doc) {
            out.push(value);
        }
    }
    Ok(out)
}

pub(crate) async fn get_room_messages(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<MessagesQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let rooms_coll = state.db.collection::<RoomRecord>("rooms");
    if rooms_coll
        .find_one(doc! { "_id": &room_id })
        .await
        .ok()
        .flatten()
        .is_none()
    {
        return Err(error_response(StatusCode::NOT_FOUND, "Room not found"));
    }

    {
        let rm = state.room_members.read().await;
        if !rm
            .get(&room_id)
            .map(|m| m.contains(&user_id))
            .unwrap_or(false)
        {
            return Err(error_response(
                StatusCode::FORBIDDEN,
                "Not a member of this room",
            ));
        }
    }

    let limit = query.limit.unwrap_or(50) as i64;
    let msg_coll = state.db.collection::<mongodb::bson::Document>("messages");

    // Enforce channel view_roles access.
    // Build an allowed-channel set for this user; None means privileged (no restriction).
    let allowed_channels = get_allowed_channel_ids(&state, &room_id, &user_id).await;

    // If a specific channel_id was requested, verify the user can see it.
    if let Some(ref cid) = query.channel_id {
        if let Some(ref ids) = allowed_channels {
            if !ids.contains(cid) {
                return Err(error_response(
                    StatusCode::FORBIDDEN,
                    "You do not have access to this channel",
                ));
            }
        }
    }

    // Exclude thread messages (those with a thread_id field) from room message feed
    // If channel_id is provided, filter strictly by it; otherwise show messages without a channel_id
    // For showcase channels, also filter by showcase_pane if provided
    let base_filter = if let Some(ref cid) = query.channel_id {
        if let Some(ref pane) = query.showcase_pane {
            doc! { "room_id": &room_id, "thread_id": { "$exists": false }, "redacted": { "$ne": true }, "channel_id": cid, "content.showcase_pane": pane }
        } else {
            doc! { "room_id": &room_id, "thread_id": { "$exists": false }, "redacted": { "$ne": true }, "channel_id": cid }
        }
    } else {
        // No specific channel requested — restrict to visible channels so private
        // channel content cannot be read by iterating the room without a channel_id.
        if let Some(ref ids) = allowed_channels {
            let bson_ids: Vec<mongodb::bson::Bson> = ids
                .iter()
                .map(|s| mongodb::bson::Bson::String(s.clone()))
                .collect();
            doc! { "room_id": &room_id, "thread_id": { "$exists": false }, "redacted": { "$ne": true }, "$or": [
                { "channel_id": { "$in": bson_ids } },
                { "channel_id": { "$exists": false } }
            ]}
        } else {
            doc! { "room_id": &room_id, "thread_id": { "$exists": false }, "redacted": { "$ne": true } }
        }
    };

    // ─── Paging ──────────────────────────────────────────────────────────
    //
    // Keyset, not offset. `skip(n)` makes Mongo walk n documents, so scrolling
    // back through a long channel got slower the further back you went, and
    // the `total` this used to need was a second full count on every read.
    //
    // The cursor is the pair (origin_server_ts, event_id). The timestamp alone
    // is not enough: it is milliseconds and two messages regularly share one,
    // and a page boundary landing between them would silently skip or repeat
    // whichever the sort happened to put second.
    let fetch = limit + 1; // one extra: its presence is the has_more answer

    let mut chunk: Vec<Value> = Vec::new();
    let has_more;

    if let Some(around_ts) = query.around_ts {
        // Jump-to-message: a page centred on an anchor. Two ranges from the
        // anchor outwards, which is the same index walk in both directions —
        // where this previously counted the anchor's ordinal position first.
        let half = (limit / 2).max(1);

        let older = fetch_page(
            &msg_coll,
            and_filter(
                &base_filter,
                doc! { "origin_server_ts": { "$lte": around_ts } },
            ),
            doc! { "origin_server_ts": -1, "event_id": -1 },
            half + 1,
        )
        .await?;
        has_more = older.len() as i64 > half;
        let mut older: Vec<Value> = older.into_iter().take(half as usize).collect();
        older.reverse();

        let newer = fetch_page(
            &msg_coll,
            and_filter(
                &base_filter,
                doc! { "origin_server_ts": { "$gt": around_ts } },
            ),
            doc! { "origin_server_ts": 1, "event_id": 1 },
            half,
        )
        .await?;

        chunk.extend(older);
        chunk.extend(newer);
    } else if let Some(after_ts) = query.after_ts {
        // Gap recovery: everything the client missed, oldest first.
        let cursor_filter = match query.after_event_id.as_deref() {
            Some(event_id) if !event_id.is_empty() => doc! { "$or": [
                { "origin_server_ts": { "$gt": after_ts } },
                { "origin_server_ts": after_ts, "event_id": { "$gt": event_id } },
            ]},
            _ => doc! { "origin_server_ts": { "$gt": after_ts } },
        };
        let page = fetch_page(
            &msg_coll,
            and_filter(&base_filter, cursor_filter),
            doc! { "origin_server_ts": 1, "event_id": 1 },
            fetch,
        )
        .await?;
        // Here "more" means the gap was wider than one page, so the client
        // should ask again from the last message it just received.
        has_more = page.len() as i64 > limit;
        chunk = page.into_iter().take(limit as usize).collect();
    } else {
        // The newest page, or the one before whatever the client already holds.
        let cursor_filter = match (query.before_ts, query.before_event_id.as_deref()) {
            (Some(ts), Some(event_id)) if !event_id.is_empty() => doc! { "$or": [
                { "origin_server_ts": { "$lt": ts } },
                { "origin_server_ts": ts, "event_id": { "$lt": event_id } },
            ]},
            (Some(ts), _) => doc! { "origin_server_ts": { "$lt": ts } },
            _ => doc! {},
        };
        let page = fetch_page(
            &msg_coll,
            and_filter(&base_filter, cursor_filter),
            doc! { "origin_server_ts": -1, "event_id": -1 },
            fetch,
        )
        .await?;
        has_more = page.len() as i64 > limit;
        // Read newest-first so the cursor works, rendered oldest-first.
        chunk = page.into_iter().take(limit as usize).rev().collect();
    }

    // Batch-fetch reactions and thread reply counts for all messages in the chunk
    let event_ids: Vec<String> = chunk
        .iter()
        .filter_map(|m| m.get("event_id").and_then(|v| v.as_str()).map(String::from))
        .collect();
    let reactions_map = get_reactions_for_events(&state, &event_ids).await;
    let thread_counts = get_thread_counts_for_events(&state, &event_ids).await;

    // Attach reactions and thread reply counts to each message
    for msg in chunk.iter_mut() {
        let eid = msg
            .get("event_id")
            .and_then(|v| v.as_str())
            .map(String::from);
        if let Some(eid) = eid {
            if let Some(reactions) = reactions_map.get(&eid) {
                if !reactions.is_empty() {
                    msg.as_object_mut().unwrap().insert(
                        "reactions".to_string(),
                        serde_json::to_value(reactions).unwrap(),
                    );
                }
            }
            if let Some(&count) = thread_counts.get(&eid) {
                if count > 0 {
                    msg.as_object_mut().unwrap().insert(
                        "thread_reply_count".to_string(),
                        serde_json::to_value(count).unwrap(),
                    );
                }
            }
        }
    }

    Ok(Json(json!({
        "has_more": has_more,
        "chunk": chunk
    })))
}

pub(crate) async fn redact_message(
    State(state): State<Arc<AppState>>,
    Path((room_id, event_id, txn_id)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let _ = txn_id;
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let rooms_coll = state.db.collection::<RoomRecord>("rooms");
    if rooms_coll
        .find_one(doc! { "_id": &room_id })
        .await
        .ok()
        .flatten()
        .is_none()
    {
        return Err(error_response(StatusCode::NOT_FOUND, "Room not found"));
    }

    {
        let rm = state.room_members.read().await;
        if !rm
            .get(&room_id)
            .map(|m| m.contains(&user_id))
            .unwrap_or(false)
        {
            return Err(error_response(
                StatusCode::FORBIDDEN,
                "Not a member of this room",
            ));
        }
    }

    let msg_coll = state.db.collection::<mongodb::bson::Document>("messages");
    let msg = msg_coll
        .find_one(doc! { "event_id": &event_id, "room_id": &room_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Message not found"))?;

    let msg_sender = msg.get_str("sender").ok().unwrap_or("");
    let is_own = msg_sender == user_id;
    if !is_own {
        let caller_is_mod = is_moderator_or_owner(&state, &room_id, &user_id).await;
        if !caller_is_mod {
            return Err(error_response(
                StatusCode::FORBIDDEN,
                "Can only delete your own messages",
            ));
        }
        // Moderators can't delete owner's messages
        let caller_role = get_user_role(&state, &room_id, &user_id).await;
        if caller_role == "moderator" {
            let sender_role = get_user_role(&state, &room_id, msg_sender).await;
            if sender_role == "owner" {
                return Err(error_response(
                    StatusCode::FORBIDDEN,
                    "Moderators cannot delete the owner's messages",
                ));
            }
        }
    }

    // Update message in MongoDB
    let _ = msg_coll
        .update_one(
            doc! { "event_id": &event_id, "room_id": &room_id },
            doc! {
                "$set": {
                    "content": { "msgtype": "m.text", "body": "[deleted]" },
                    "redacted": true,
                    "redacted_by": &user_id,
                    "redacted_at": now_millis()
                }
            },
        )
        .await;

    // A deleted message must not linger in the pin list.
    super::pins::remove_pin_for_event(&state, &room_id, &event_id).await;

    let redaction_event_id = generate_id("$");
    let redaction_event = json!({
        "type": "m.room.redaction",
        "room_id": room_id,
        "sender": user_id,
        "redacts": event_id,
        "event_id": redaction_event_id,
        "origin_server_ts": now_millis()
    });

    broadcast_to_room(&state, &room_id, &redaction_event).await;

    // Only a moderator deleting someone else's message is a moderation
    // action. Someone deleting their own is not, and logging it would turn the
    // audit log into a record of ordinary use.
    if !is_own {
        audit::record(
            &state,
            &room_id,
            &user_id,
            audit::AuditAction::MessageDeleted,
            &event_id,
            &format!("message by {msg_sender}"),
        )
        .await;
    }

    Ok(Json(json!({"event_id": redaction_event_id})))
}

/// DELETE /api/rooms/{room_id}/messages/{event_id}
/// Hard-deletes a notification message (m.system / m.watchparty) with no trace.
/// Only owners and moderators may call this.
pub(crate) async fn delete_notification(
    State(state): State<Arc<AppState>>,
    Path((room_id, event_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let role = get_user_role(&state, &room_id, &user_id).await;
    if role != "owner" && role != "moderator" {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "Only owners and moderators can delete notifications",
        ));
    }

    let msg_coll = state.db.collection::<mongodb::bson::Document>("messages");
    let msg = msg_coll
        .find_one(doc! { "event_id": &event_id, "room_id": &room_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Message not found"))?;

    let msgtype = msg
        .get_document("content")
        .ok()
        .and_then(|c| c.get_str("msgtype").ok())
        .unwrap_or("");
    if msgtype != "m.system" && msgtype != "m.watchparty" {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "Only notification messages can be hard-deleted",
        ));
    }

    let _ = msg_coll
        .delete_one(doc! { "event_id": &event_id, "room_id": &room_id })
        .await;

    super::pins::remove_pin_for_event(&state, &room_id, &event_id).await;

    let removal_event = json!({
        "type": "m.room.message_removed",
        "room_id": room_id,
        "event_id": event_id,
    });
    broadcast_to_room(&state, &room_id, &removal_event).await;

    Ok(Json(json!({ "deleted": true })))
}

pub(crate) async fn edit_message(
    State(state): State<Arc<AppState>>,
    Path((room_id, event_id, txn_id)): Path<(String, String, String)>,
    headers: HeaderMap,
    Json(req): Json<EditMessageRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let _ = txn_id;
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;

    // Try JWT first, then fall back to bot token
    let user_id_opt = get_user_from_token(&state, &token);
    let bot_record = if user_id_opt.is_none() {
        get_bot_from_token(&state, &token).await
    } else {
        None
    };

    let user_id = if let Some(uid) = user_id_opt {
        uid
    } else if let Some(ref bot) = bot_record {
        format!("bot:{}", bot.bot_id)
    } else {
        return Err(error_response(StatusCode::UNAUTHORIZED, "Invalid token"));
    };

    let rooms_coll = state.db.collection::<RoomRecord>("rooms");
    if rooms_coll
        .find_one(doc! { "_id": &room_id })
        .await
        .ok()
        .flatten()
        .is_none()
    {
        return Err(error_response(StatusCode::NOT_FOUND, "Room not found"));
    }

    {
        let rm = state.room_members.read().await;
        if !rm
            .get(&room_id)
            .map(|m| m.contains(&user_id))
            .unwrap_or(false)
        {
            return Err(error_response(
                StatusCode::FORBIDDEN,
                "Not a member of this room",
            ));
        }
    }

    let new_body = req.body.trim().to_string();
    if new_body.is_empty() {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "Message body cannot be empty",
        ));
    }

    let msg_coll = state.db.collection::<mongodb::bson::Document>("messages");
    let msg = msg_coll
        .find_one(doc! { "event_id": &event_id, "room_id": &room_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Message not found"))?;

    if msg.get_str("sender").ok() != Some(&user_id) {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "Can only edit your own messages",
        ));
    }

    if msg.get_bool("redacted").unwrap_or(false) {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "Cannot edit a deleted message",
        ));
    }

    let original_body = msg
        .get_document("content")
        .ok()
        .and_then(|c| c.get_str("body").ok())
        .unwrap_or("")
        .to_string();

    // Build the update document
    let mut set_doc = doc! {
        "content.body": &new_body,
        "edited": true,
        "edited_at": now_millis()
    };

    // If embeds are provided, update them too
    let embeds_json = if let Some(ref embeds) = req.embeds {
        let bson_embeds =
            mongodb::bson::to_bson(embeds).unwrap_or(mongodb::bson::Bson::Array(vec![]));
        set_doc.insert("content.embeds", bson_embeds);
        Some(json!(embeds))
    } else {
        None
    };

    // Update in MongoDB
    let _ = msg_coll
        .update_one(
            doc! { "event_id": &event_id, "room_id": &room_id },
            doc! { "$set": set_doc },
        )
        .await;

    let edit_event_id = generate_id("$");
    let mut edit_event = json!({
        "type": "m.room.edit",
        "room_id": room_id,
        "sender": user_id,
        "edits": event_id,
        "new_body": new_body,
        "original_body": original_body,
        "event_id": edit_event_id,
        "origin_server_ts": now_millis()
    });

    if let Some(embeds) = embeds_json {
        edit_event["new_embeds"] = embeds;
    }

    broadcast_to_room(&state, &room_id, &edit_event).await;
    Ok(Json(json!({"event_id": edit_event_id})))
}

pub(crate) async fn get_thread_messages(
    State(state): State<Arc<AppState>>,
    Path((room_id, thread_event_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    {
        let rm = state.room_members.read().await;
        if !rm
            .get(&room_id)
            .map(|m| m.contains(&user_id))
            .unwrap_or(false)
        {
            return Err(error_response(
                StatusCode::FORBIDDEN,
                "Not a member of this room",
            ));
        }
    }

    let msg_coll = state.db.collection::<mongodb::bson::Document>("messages");

    // Fetch the root message
    let root_doc = msg_coll
        .find_one(doc! { "event_id": &thread_event_id, "room_id": &room_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Thread root message not found"))?;

    // Check channel-level view permissions on the root message
    if let Some(ch_id) = root_doc
        .get_str("channel_id")
        .ok()
        .filter(|s| !s.is_empty())
    {
        let role = get_user_role(&state, &room_id, &user_id).await;
        if role != "owner" && role != "moderator" {
            let channels_coll = state.db.collection::<ChannelRecord>("channels");
            if let Ok(Some(ch)) = channels_coll.find_one(doc! { "_id": ch_id }).await {
                if !ch.view_roles.is_empty() {
                    let user_roles = get_user_custom_role_ids(&state, &room_id, &user_id).await;
                    if !ch.view_roles.iter().any(|r| user_roles.contains(r)) {
                        return Err(error_response(
                            StatusCode::FORBIDDEN,
                            "You do not have access to this channel",
                        ));
                    }
                }
            }
        }
    }

    let mut root_doc = root_doc;
    root_doc.remove("_id");
    let root_msg = serde_json::to_value(&root_doc).unwrap_or(serde_json::Value::Null);

    // Fetch thread replies
    let mut cursor = msg_coll
        .find(doc! { "room_id": &room_id, "thread_id": &thread_event_id, "redacted": { "$ne": true } })
        .sort(doc! { "origin_server_ts": 1 })
        .await
        .map_err(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "DB query failed"))?;

    let mut messages: Vec<Value> = Vec::new();
    while let Ok(Some(doc)) = cursor.try_next().await {
        let mut doc = doc;
        doc.remove("_id");
        if let Ok(val) = serde_json::to_value(&doc) {
            messages.push(val);
        }
    }

    // Attach reactions to thread messages
    let event_ids: Vec<String> = messages
        .iter()
        .filter_map(|m| m.get("event_id").and_then(|v| v.as_str()).map(String::from))
        .collect();
    let reactions_map = get_reactions_for_events(&state, &event_ids).await;
    for msg in messages.iter_mut() {
        if let Some(eid) = msg.get("event_id").and_then(|v| v.as_str()) {
            if let Some(reactions) = reactions_map.get(eid) {
                if !reactions.is_empty() {
                    msg.as_object_mut().unwrap().insert(
                        "reactions".to_string(),
                        serde_json::to_value(reactions).unwrap(),
                    );
                }
            }
        }
    }

    Ok(Json(json!({
        "root": root_msg,
        "messages": messages
    })))
}

pub(crate) async fn send_thread_message(
    State(state): State<Arc<AppState>>,
    Path((room_id, thread_event_id, txn_id)): Path<(String, String, String)>,
    headers: HeaderMap,
    Json(req): Json<SendMessageRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let _ = txn_id;
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

    {
        let rm = state.room_members.read().await;
        if !rm
            .get(&room_id)
            .map(|m| m.contains(&user_id))
            .unwrap_or(false)
        {
            return Err(error_response(
                StatusCode::FORBIDDEN,
                "Not a member of this room",
            ));
        }
    }

    {
        let perms = effective_permissions(&state, &room_id, &user_id).await;
        if !perms.send_messages {
            return Err(error_response(
                StatusCode::FORBIDDEN,
                "You do not have permission to send messages in this room",
            ));
        }
        if !perms.attach_files && body_has_attachment(&req.body) {
            return Err(error_response(
                StatusCode::FORBIDDEN,
                "You do not have permission to attach files in this room",
            ));
        }
    }

    if room.read_only {
        let role = get_user_role(&state, &room_id, &user_id).await;
        if role != "owner" && role != "moderator" {
            return Err(error_response(
                StatusCode::FORBIDDEN,
                "This room is read-only",
            ));
        }
    }

    // Check channel-level view/write permissions on the thread's root message
    let msg_coll = state.db.collection::<mongodb::bson::Document>("messages");
    if let Ok(Some(root_doc)) = msg_coll
        .find_one(doc! { "event_id": &thread_event_id, "room_id": &room_id })
        .await
    {
        if let Ok(ch_id) = root_doc.get_str("channel_id") {
            if !ch_id.is_empty() {
                let channels_coll = state.db.collection::<ChannelRecord>("channels");
                if let Ok(Some(ch)) = channels_coll.find_one(doc! { "_id": ch_id }).await {
                    let role = get_user_role(&state, &room_id, &user_id).await;
                    let is_privileged = role == "owner" || role == "moderator";
                    if !is_privileged {
                        if !ch.view_roles.is_empty() {
                            let user_roles =
                                get_user_custom_role_ids(&state, &room_id, &user_id).await;
                            if !ch.view_roles.iter().any(|r| user_roles.contains(r)) {
                                return Err(error_response(
                                    StatusCode::FORBIDDEN,
                                    "You do not have access to this channel",
                                ));
                            }
                        }
                        if !ch.write_roles.is_empty() {
                            let user_roles =
                                get_user_custom_role_ids(&state, &room_id, &user_id).await;
                            if !ch.write_roles.iter().any(|r| user_roles.contains(r)) {
                                return Err(error_response(
                                    StatusCode::FORBIDDEN,
                                    "You do not have permission to send messages in this channel",
                                ));
                            }
                        }
                    }
                }
            }
        }
    }

    const MAX_MESSAGE_LENGTH: usize = 4000;
    let emoji_marker = regex::Regex::new(r":emoji\{[^}]+\}:").unwrap();
    let display_body = emoji_marker.replace_all(&req.body, "X");
    if display_body.len() > MAX_MESSAGE_LENGTH {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "Message exceeds maximum length of 4000 characters",
        ));
    }

    let event_id = generate_id("$");
    let timestamp = now_millis();

    let content = json!({
        "msgtype": req.msgtype.unwrap_or_else(|| "m.text".to_string()),
        "body": req.body
    });

    let event = json!({
        "type": "m.room.message",
        "room_id": room_id,
        "sender": user_id,
        "content": content,
        "event_id": event_id,
        "thread_id": thread_event_id,
        "origin_server_ts": timestamp
    });

    if let Ok(doc) = mongodb::bson::to_document(&event) {
        let _ = msg_coll.insert_one(doc).await;
    }

    // Count total thread replies for the broadcast
    let reply_count = msg_coll
        .count_documents(doc! { "room_id": &room_id, "thread_id": &thread_event_id })
        .await
        .unwrap_or(0);

    // Extract @mentions from message body and auto-add mentioned users to thread
    let mention_re = Regex::new(r"@(\w+)").unwrap();
    let mentioned_names: Vec<String> = mention_re
        .captures_iter(&req.body)
        .filter_map(|c| c.get(1).map(|m| m.as_str().to_string()))
        .collect();

    let mut added_participants: Vec<String> = Vec::new();
    if !mentioned_names.is_empty() {
        // Look up room members and match by username portion of user_id
        let rm = state.room_members.read().await;
        let room_member_list = rm.get(&room_id).cloned().unwrap_or_default();
        drop(rm);

        let mut new_participant_ids: Vec<String> = Vec::new();
        for name in &mentioned_names {
            let lower = name.to_lowercase();
            for member_id in &room_member_list {
                // user_id format: @username:localhost
                let username = member_id
                    .split(':')
                    .next()
                    .unwrap_or("")
                    .trim_start_matches('@')
                    .to_lowercase();
                if username == lower && member_id != &user_id {
                    new_participant_ids.push(member_id.clone());
                }
            }
        }

        if !new_participant_ids.is_empty() {
            // Add to thread_participants array on the root message (deduplicated)
            // Also ensure the sender is a participant
            let all_to_add: Vec<&str> = new_participant_ids.iter().map(|s| s.as_str()).collect();
            let _ = msg_coll
                .update_one(
                    doc! { "event_id": &thread_event_id, "room_id": &room_id },
                    doc! { "$addToSet": { "thread_participants": { "$each": &all_to_add } } },
                )
                .await;

            added_participants = new_participant_ids;
        }
    }

    // Always ensure the sender is a thread participant
    let _ = msg_coll
        .update_one(
            doc! { "event_id": &thread_event_id, "room_id": &room_id },
            doc! { "$addToSet": { "thread_participants": &user_id } },
        )
        .await;

    // Broadcast to all room members so they can update thread reply counts
    let broadcast_event = json!({
        "type": "m.thread.message",
        "room_id": room_id,
        "sender": user_id,
        "event_id": event_id,
        "thread_id": thread_event_id,
        "content": content,
        "thread_reply_count": reply_count,
        "origin_server_ts": timestamp,
        "added_participants": added_participants
    });

    broadcast_to_room(&state, &room_id, &broadcast_event).await;

    Ok(Json(json!({"event_id": event_id})))
}

pub(crate) async fn set_thread_name(
    State(state): State<Arc<AppState>>,
    Path((room_id, thread_event_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(req): Json<SetThreadNameRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    {
        let rm = state.room_members.read().await;
        if !rm
            .get(&room_id)
            .map(|m| m.contains(&user_id))
            .unwrap_or(false)
        {
            return Err(error_response(
                StatusCode::FORBIDDEN,
                "Not a member of this room",
            ));
        }
    }

    let msg_coll = state.db.collection::<mongodb::bson::Document>("messages");

    let exists = msg_coll
        .find_one(doc! { "event_id": &thread_event_id, "room_id": &room_id })
        .await
        .ok()
        .flatten()
        .is_some();

    if !exists {
        return Err(error_response(
            StatusCode::NOT_FOUND,
            "Thread root message not found",
        ));
    }

    let name = req.name.trim().to_string();

    msg_coll
        .update_one(
            doc! { "event_id": &thread_event_id, "room_id": &room_id },
            doc! { "$set": { "thread_name": &name } },
        )
        .await
        .map_err(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "DB update failed"))?;

    let broadcast = json!({
        "type": "m.thread.name",
        "room_id": room_id,
        "thread_id": thread_event_id,
        "name": name,
        "sender": user_id,
    });
    broadcast_to_room(&state, &room_id, &broadcast).await;

    Ok(Json(json!({ "ok": true })))
}

pub(crate) async fn delete_thread(
    State(state): State<Arc<AppState>>,
    Path((room_id, thread_event_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    {
        let rm = state.room_members.read().await;
        if !rm
            .get(&room_id)
            .map(|m| m.contains(&user_id))
            .unwrap_or(false)
        {
            return Err(error_response(
                StatusCode::FORBIDDEN,
                "Not a member of this room",
            ));
        }
    }

    let msg_coll = state.db.collection::<mongodb::bson::Document>("messages");

    let root_doc = msg_coll
        .find_one(doc! { "event_id": &thread_event_id, "room_id": &room_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Thread not found"))?;

    let sender = root_doc.get_str("sender").unwrap_or("").to_string();
    let my_role = get_user_role(&state, &room_id, &user_id).await;
    let sender_role = get_user_role(&state, &room_id, &sender).await;

    let is_thread_owner = sender == user_id;
    let can_delete_others = (my_role == "owner" && sender_role != "owner")
        || (my_role == "moderator" && sender_role == "member");

    if !is_thread_owner && !can_delete_others {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "Only the thread owner or a moderator/owner can delete this thread",
        ));
    }

    // Delete all thread reply messages
    let _ = msg_coll
        .delete_many(doc! { "room_id": &room_id, "thread_id": &thread_event_id })
        .await;

    // Delete the root message
    let _ = msg_coll
        .delete_one(doc! { "event_id": &thread_event_id, "room_id": &room_id })
        .await;

    let broadcast = json!({
        "type": "m.thread.deleted",
        "room_id": room_id,
        "thread_id": thread_event_id,
        "sender": user_id,
    });
    broadcast_to_room(&state, &room_id, &broadcast).await;

    Ok(Json(json!({ "ok": true })))
}

pub(crate) async fn get_room_threads(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<ThreadListQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    {
        let rm = state.room_members.read().await;
        if !rm
            .get(&room_id)
            .map(|m| m.contains(&user_id))
            .unwrap_or(false)
        {
            return Err(error_response(
                StatusCode::FORBIDDEN,
                "Not a member of this room",
            ));
        }
    }

    let msg_coll = state.db.collection::<mongodb::bson::Document>("messages");

    // Collect all distinct thread_ids used in this room
    let raw_ids = msg_coll
        .distinct(
            "thread_id",
            doc! { "room_id": &room_id, "thread_id": { "$exists": true } },
        )
        .await
        .unwrap_or_default();

    let thread_ids: Vec<String> = raw_ids
        .into_iter()
        .filter_map(|v| v.as_str().map(String::from))
        .collect();

    if thread_ids.is_empty() {
        return Ok(Json(
            json!({ "threads": [], "has_more": false, "next_offset": 0 }),
        ));
    }

    // Fetch the root messages for those thread ids
    let mut cursor = msg_coll
        .find(doc! { "event_id": { "$in": &thread_ids }, "room_id": &room_id })
        .sort(doc! { "origin_server_ts": -1 })
        .await
        .map_err(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "DB query failed"))?;

    let mut root_msgs: Vec<Value> = Vec::new();
    while let Ok(Some(doc)) = cursor.try_next().await {
        let mut doc = doc;
        doc.remove("_id");
        if let Ok(val) = serde_json::to_value(&doc) {
            root_msgs.push(val);
        }
    }

    // Scope thread search to a single channel (or the general/no-channel feed).
    if let Some(cid) = query.channel_id.as_deref().filter(|c| !c.is_empty()) {
        root_msgs.retain(|msg| msg.get("channel_id").and_then(|v| v.as_str()) == Some(cid));
    } else if query.no_channel_only.unwrap_or(false) {
        root_msgs.retain(|msg| msg.get("channel_id").is_none());
    }

    // Filter out threads from channels the user cannot view
    let role = get_user_role(&state, &room_id, &user_id).await;
    let is_privileged = role == "owner" || role == "moderator";
    if !is_privileged {
        let channels_coll = state.db.collection::<ChannelRecord>("channels");
        // Collect channel_ids referenced by root messages
        let channel_ids: Vec<String> = root_msgs
            .iter()
            .filter_map(|m| {
                m.get("channel_id")
                    .and_then(|v| v.as_str())
                    .map(String::from)
            })
            .collect::<std::collections::HashSet<_>>()
            .into_iter()
            .collect();
        // Fetch channels with view_roles restrictions
        let mut restricted_channels: std::collections::HashMap<String, Vec<String>> =
            std::collections::HashMap::new();
        if !channel_ids.is_empty() {
            let mut ch_cursor = channels_coll
                .find(doc! { "_id": { "$in": &channel_ids }, "view_roles": { "$ne": [] } })
                .await
                .ok();
            if let Some(ref mut cursor) = ch_cursor {
                while let Ok(Some(ch)) = cursor.try_next().await {
                    if !ch.view_roles.is_empty() {
                        restricted_channels.insert(ch.channel_id.clone(), ch.view_roles.clone());
                    }
                }
            }
        }
        if !restricted_channels.is_empty() {
            let user_roles = get_user_custom_role_ids(&state, &room_id, &user_id).await;
            root_msgs.retain(|msg| {
                let ch_id = msg.get("channel_id").and_then(|v| v.as_str()).unwrap_or("");
                if let Some(view_roles) = restricted_channels.get(ch_id) {
                    view_roles.iter().any(|r| user_roles.contains(r))
                } else {
                    true // no restriction or no channel_id
                }
            });
        }
    }

    // Attach reply counts
    let event_ids: Vec<String> = root_msgs
        .iter()
        .filter_map(|m| m.get("event_id").and_then(|v| v.as_str()).map(String::from))
        .collect();
    let counts = get_thread_counts_for_events(&state, &event_ids).await;
    for msg in root_msgs.iter_mut() {
        if let Some(eid) = msg.get("event_id").and_then(|v| v.as_str()) {
            let count = counts.get(eid).copied().unwrap_or(0);
            msg.as_object_mut()
                .unwrap()
                .insert("thread_reply_count".to_string(), json!(count));
        }
    }

    // Optional text filter against thread_name and content.body
    if let Some(q) = query.q.as_deref() {
        let q = q.to_lowercase();
        if !q.is_empty() {
            root_msgs.retain(|msg| {
                let name_match = msg
                    .get("thread_name")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_lowercase().contains(&q))
                    .unwrap_or(false);
                let body_match = msg
                    .get("content")
                    .and_then(|c| c.get("body"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_lowercase().contains(&q))
                    .unwrap_or(false);
                name_match || body_match
            });
        }
    }

    // Threads are filtered in memory above, so the page is taken at the end.
    let limit = query.limit.unwrap_or(50).clamp(1, 100);
    let offset = query.offset.unwrap_or(0);
    let total = root_msgs.len();
    let page: Vec<Value> = root_msgs.into_iter().skip(offset).take(limit).collect();
    let next_offset = offset.saturating_add(page.len());
    let has_more = next_offset < total;

    Ok(Json(json!({
        "threads": page,
        "has_more": has_more,
        "next_offset": next_offset
    })))
}

pub(crate) async fn search_messages(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<SearchQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    {
        let rm = state.room_members.read().await;
        if !rm
            .get(&room_id)
            .map(|m| m.contains(&user_id))
            .unwrap_or(false)
        {
            return Err(error_response(
                StatusCode::FORBIDDEN,
                "Not a member of this room",
            ));
        }
    }

    let limit = query.limit.unwrap_or(50).clamp(1, 100);
    let offset = query.offset.unwrap_or(0);
    let filter = query.filter.as_deref().unwrap_or("all");
    // Every use of this reaches a `$regex`. Escaped once here so no branch can
    // forget: unescaped, searching for "a.b" quietly matches "axb", and a term
    // like "(a+)+b" makes the server backtrack over every message in the room.
    let q = regex_escape(&query.q);
    let q = &q;

    let channel_scope = query.channel_id.filter(|c| !c.is_empty());
    if let Some(ref cid) = channel_scope {
        let allowed_ids = get_allowed_channel_ids(&state, &room_id, &user_id).await;
        if let Some(ids) = &allowed_ids {
            if !ids.contains(cid) {
                return Err(error_response(
                    StatusCode::FORBIDDEN,
                    "You do not have access to this channel",
                ));
            }
        }
    }

    let mongo_filter = match filter {
        "mention" => {
            doc! {
                "room_id": &room_id,
                "redacted": { "$ne": true },
                "content.body": { "$regex": format!("@{}\\b", q), "$options": "i" }
            }
        }
        "user" => {
            doc! {
                "room_id": &room_id,
                "redacted": { "$ne": true },
                "sender": { "$regex": format!("^@{q}"), "$options": "i" }
            }
        }
        "file" => {
            let file_type = query.file_type.as_deref().unwrap_or("all");
            let ext_pattern = match file_type {
                "image" => r"\.(jpg|jpeg|png|gif|webp|bmp|svg)(\?|$|\s)",
                "video" => r"\.(mp4|webm|ogg|mov)(\?|$|\s)",
                "audio" => r"\.(mp3|wav|flac|aac|m4a)(\?|$|\s)",
                "document" => r"\.(pdf|doc|docx|xls|xlsx|txt|zip|tar|gz|rar|7z|csv)(\?|$|\s)",
                _ => {
                    r"\.(jpg|jpeg|png|gif|webp|bmp|svg|mp4|webm|ogg|mov|mp3|wav|flac|aac|m4a|pdf|doc|docx|xls|xlsx|txt|zip|tar|gz|rar|7z|csv)(\?|$|\s)"
                }
            };

            let mut conditions = vec![
                doc! { "room_id": &room_id },
                doc! { "redacted": { "$ne": true } },
                doc! { "content.body": { "$regex": ext_pattern, "$options": "i" } },
            ];

            if !q.is_empty() {
                conditions.push(doc! { "content.body": { "$regex": q, "$options": "i" } });
            }

            doc! { "$and": conditions }
        }
        _ => {
            // "all" — search by message body
            doc! {
                "room_id": &room_id,
                "redacted": { "$ne": true },
                "content.body": { "$regex": q, "$options": "i" }
            }
        }
    };

    // Restrict search results to channels the user is allowed to see.
    let mongo_filter =
        if let Some(allowed) = get_allowed_channel_ids(&state, &room_id, &user_id).await {
            let bson_ids: Vec<mongodb::bson::Bson> = allowed
                .iter()
                .map(|s| mongodb::bson::Bson::String(s.clone()))
                .collect();
            doc! { "$and": [
                mongo_filter,
                { "$or": [
                    { "channel_id": { "$in": bson_ids } },
                    { "channel_id": { "$exists": false } }
                ]}
            ]}
        } else {
            mongo_filter
        };

    // Scope search to a single channel (or to the general/no-channel feed).
    let mongo_filter = if let Some(ref cid) = channel_scope {
        doc! { "$and": [mongo_filter, { "channel_id": cid }] }
    } else if query.no_channel_only.unwrap_or(false) {
        doc! { "$and": [mongo_filter, { "channel_id": { "$exists": false } }] }
    } else {
        mongo_filter
    };

    let msg_coll = state.db.collection::<mongodb::bson::Document>("messages");
    // Fetch one past the page so `has_more` costs no extra count query.
    let mut cursor = msg_coll
        .find(mongo_filter)
        .sort(doc! { "origin_server_ts": -1 })
        .skip(offset)
        .limit(limit + 1)
        .await
        .map_err(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "DB query failed"))?;

    let mut results: Vec<Value> = Vec::new();
    while let Ok(Some(doc)) = cursor.try_next().await {
        let mut doc = doc;
        doc.remove("_id");
        if let Ok(val) = serde_json::to_value(&doc) {
            results.push(val);
        }
    }

    let has_more = results.len() as i64 > limit;
    results.truncate(limit as usize);
    let next_offset = offset + results.len() as u64;

    Ok(Json(json!({
        "results": results,
        "has_more": has_more,
        "next_offset": next_offset
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cursor_is_anded_with_the_visibility_filter() {
        // The base filter carries its own $or for channel visibility. Merging
        // a cursor's $or in as a key would replace it, handing back messages
        // from channels the caller cannot see — so it has to be an $and.
        let base = doc! { "room_id": "!r", "$or": [
            { "channel_id": { "$in": ["#a"] } },
            { "channel_id": { "$exists": false } },
        ]};
        let cursor = doc! { "$or": [
            { "origin_server_ts": { "$lt": 100 } },
            { "origin_server_ts": 100, "event_id": { "$lt": "$x" } },
        ]};

        let combined = and_filter(&base, cursor);
        let clauses = combined.get_array("$and").expect("combined under $and");
        assert_eq!(clauses.len(), 2);
        // Both survive intact, so neither can silently drop the other.
        assert!(clauses[0].as_document().unwrap().contains_key("$or"));
        assert!(clauses[1].as_document().unwrap().contains_key("$or"));
        assert_eq!(
            clauses[0]
                .as_document()
                .unwrap()
                .get_str("room_id")
                .unwrap(),
            "!r"
        );
    }

    #[test]
    fn an_empty_cursor_leaves_the_filter_alone() {
        // The newest page has no cursor; wrapping it in a pointless $and would
        // only make the query harder for the planner to match to an index.
        let base = doc! { "room_id": "!r" };
        let combined = and_filter(&base, doc! {});
        assert_eq!(combined, base);
        assert!(!combined.contains_key("$and"));
    }
}
