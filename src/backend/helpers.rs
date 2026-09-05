use super::{
    constants::{MAX_USERNAME_LENGTH, MIN_USERNAME_LENGTH},
    state::{
        AppState, ChannelRecord, PermissionOverwrite, ReactionRecord, RolePermissions,
        RoomMemberRecord,
    },
};
use axum::{
    extract::ws::Message,
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::Json,
};
use base64::Engine;
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::SystemTime;

// ─── JWT ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct Claims {
    pub(crate) sub: String, // user_id
    pub(crate) exp: usize,
    pub(crate) iat: usize,
}

pub(crate) fn create_access_token(user_id: &str, secret: &str) -> String {
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_secs() as usize;
    let claims = Claims {
        sub: user_id.to_string(),
        iat: now,
        exp: now + 15 * 60, // 15 minutes
    };
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .unwrap()
}

pub(crate) fn create_refresh_token(user_id: &str, secret: &str) -> String {
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_secs() as usize;
    let claims = Claims {
        sub: user_id.to_string(),
        iat: now,
        exp: now + 7 * 24 * 60 * 60, // 7 days
    };
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .unwrap()
}

pub(crate) fn decode_token(token: &str, secret: &str) -> Option<Claims> {
    decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &Validation::default(),
    )
    .ok()
    .map(|data| data.claims)
}

// ─── Password hashing ───────────────────────────────────────────────────────

pub(crate) fn hash_password(password: &str) -> String {
    use argon2::{
        password_hash::{rand_core::OsRng, SaltString},
        Argon2, PasswordHasher,
    };
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .unwrap()
        .to_string()
}

pub(crate) fn verify_password(password: &str, hash: &str) -> bool {
    use argon2::{Argon2, PasswordHash, PasswordVerifier};
    let parsed = match PasswordHash::new(hash) {
        Ok(h) => h,
        Err(_) => return false,
    };
    Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok()
}

// ─── ID generation ───────────────────────────────────────────────────────────

pub(crate) fn generate_id(prefix: &str) -> String {
    use rand::Rng;
    let bytes: [u8; 16] = rand::thread_rng().gen();
    format!(
        "{}_{}",
        prefix,
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
    )
}

pub(crate) fn format_user_id(username: &str) -> String {
    format!("@{}:localhost", username)
}

pub(crate) fn validate_username(username: &str) -> Result<(), &'static str> {
    if username.len() < MIN_USERNAME_LENGTH || username.len() > MAX_USERNAME_LENGTH {
        return Err("Username must be 3-42 characters long");
    }

    if !username
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'_')
    {
        return Err("Username may only contain letters, numbers, and underscores");
    }

    Ok(())
}

pub(crate) fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

pub(crate) fn now_secs() -> f64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_secs_f64()
}

pub(crate) fn extract_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|s| s.to_string())
}

/// Stateless JWT decode — no DB call needed.
pub(crate) fn get_user_from_token(state: &AppState, token: &str) -> Option<String> {
    decode_token(token, &state.jwt_secret).map(|c| c.sub)
}

/// Look up a bot by its opaque API token (SHA-256 hash lookup in DB).
pub(crate) async fn get_bot_from_token(
    state: &AppState,
    token: &str,
) -> Option<super::state::BotRecord> {
    use super::routes::bots::hash_bot_token;
    let token_hash = hash_bot_token(token);
    let coll = state.db.collection::<super::state::BotRecord>("bots");
    coll.find_one(mongodb::bson::doc! { "token_hash": &token_hash })
        .await
        .ok()
        .flatten()
}

pub(crate) fn error_response(status: StatusCode, detail: &str) -> (StatusCode, Json<Value>) {
    (
        status,
        Json(json!({"errcode": "M_UNKNOWN", "error": detail})),
    )
}

// ─── Admin helper ────────────────────────────────────────────────────────

pub(crate) async fn require_admin(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<String, (StatusCode, Json<Value>)> {
    let token = extract_token(headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;
    let users = state.db.collection::<super::state::UserRecord>("users");
    let user = users
        .find_one(mongodb::bson::doc! { "_id": &user_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "User not found"))?;
    if !user.is_admin {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "Admin access required",
        ));
    }
    Ok(user_id)
}

// ─── Role helpers ────────────────────────────────────────────────────────────

pub(crate) async fn get_user_role(state: &AppState, room_id: &str, user_id: &str) -> String {
    // Release the read lock immediately after reading so we don't hold it while
    // acquiring other locks (room_members) below — holding two locks in different
    // orders in different call paths can deadlock.
    let role = {
        let roles = state.room_roles.read().await;
        roles
            .get(room_id)
            .and_then(|m| m.get(user_id))
            .cloned()
            .unwrap_or_else(|| "member".to_string())
    };

    // Legacy fallback: if no explicit role is cached, check whether this user is
    // the room creator and promote them to owner.
    //
    // SECURITY: gate on active membership — a former creator who left or was kicked
    // must not retain owner-level access just because rooms.creator still names them.
    if role == "member" {
        let is_member = {
            let rm = state.room_members.read().await;
            rm.get(room_id)
                .map(|m| m.contains(&user_id.to_string()))
                .unwrap_or(false)
        };
        if !is_member {
            // Not a member → no privileges, return the lowest role.
            return "member".to_string();
        }

        use super::state::RoomRecord;
        use mongodb::bson::doc;
        let rooms_coll = state.db.collection::<RoomRecord>("rooms");
        if let Ok(Some(room)) = rooms_coll.find_one(doc! { "_id": room_id }).await {
            if room.creator == user_id {
                // Backfill the cache so we don't hit DB again
                let mut roles_w = state.room_roles.write().await;
                roles_w
                    .entry(room_id.to_string())
                    .or_default()
                    .insert(user_id.to_string(), "owner".to_string());

                // Also update MongoDB so the record is consistent
                let members_coll = state
                    .db
                    .collection::<super::state::RoomMemberRecord>("room_members");
                let _ = members_coll
                    .update_one(
                        doc! { "room_id": room_id, "user_id": user_id },
                        doc! { "$set": { "role": "owner" } },
                    )
                    .await;

                return "owner".to_string();
            }
        }
    }

    role
}

pub(crate) async fn is_moderator_or_owner(state: &AppState, room_id: &str, user_id: &str) -> bool {
    let role = get_user_role(state, room_id, user_id).await;
    role == "owner" || role == "moderator"
}

/// The permissions a user actually holds in a room — the single source of truth
/// every access check should go through.
///
/// Built-in roles are implicit grants: an owner holds everything, a moderator
/// holds a fixed legacy set, and both keep whatever their custom roles add. A
/// plain member with no custom roles gets the baseline (`RolePermissions::default`).
/// Once a member holds custom roles, the union of those roles is authoritative,
/// so a role with everything switched off is a working mute.
///
/// A DM has no roles at all, so both participants hold everything.
pub(crate) async fn effective_permissions(
    state: &AppState,
    room_id: &str,
    user_id: &str,
) -> RolePermissions {
    use super::state::{CustomRoleRecord, RoomRecord};
    use futures_util::TryStreamExt;
    use mongodb::bson::doc;

    // A non-member holds nothing, whatever roles may still name them.
    {
        let rm = state.room_members.read().await;
        if !rm
            .get(room_id)
            .map(|m| m.contains(&user_id.to_string()))
            .unwrap_or(false)
        {
            return RolePermissions::none();
        }
    }

    let rooms_coll = state.db.collection::<RoomRecord>("rooms");
    if let Ok(Some(room)) = rooms_coll.find_one(doc! { "_id": room_id }).await {
        if room.is_dm {
            return RolePermissions::all();
        }
    }

    let role = get_user_role(state, room_id, user_id).await;
    if role == "owner" {
        return RolePermissions::all();
    }

    // Union the custom roles the member holds.
    let role_ids = get_user_custom_role_ids(state, room_id, user_id).await;
    let mut custom: Option<RolePermissions> = None;
    if !role_ids.is_empty() {
        let roles_coll = state.db.collection::<CustomRoleRecord>("custom_roles");
        if let Ok(mut cursor) = roles_coll
            .find(doc! { "room_id": room_id, "_id": { "$in": &role_ids } })
            .await
        {
            while let Ok(Some(r)) = cursor.try_next().await {
                custom = Some(match custom {
                    Some(acc) => acc.union(&r.permissions),
                    None => r.permissions,
                });
            }
        }
    }

    let base = custom.unwrap_or_default();
    if role == "moderator" {
        base.union(&RolePermissions::moderator())
    } else {
        base
    }
}

/// Whether a user may pin, unpin, and otherwise curate other people's messages.
pub(crate) async fn can_manage_messages(state: &AppState, room_id: &str, user_id: &str) -> bool {
    effective_permissions(state, room_id, user_id)
        .await
        .manage_messages
}

/// Get the custom role IDs assigned to a user in a room.
pub(crate) async fn get_user_custom_role_ids(
    state: &AppState,
    room_id: &str,
    user_id: &str,
) -> Vec<String> {
    use super::state::MemberCustomRoleRecord;
    use futures_util::TryStreamExt;
    use mongodb::bson::doc;

    let coll = state
        .db
        .collection::<MemberCustomRoleRecord>("member_custom_roles");
    let mut role_ids = Vec::new();
    if let Ok(mut cursor) = coll
        .find(doc! { "room_id": room_id, "user_id": user_id })
        .await
    {
        while let Ok(Some(r)) = cursor.try_next().await {
            role_ids.push(r.role_id);
        }
    }
    role_ids
}

/// How much authority a user has over roles, as a comparable rank where a
/// **lower** number is stronger. Roles are created at the end of the list and
/// the UI sorts ascending, so position 0 sits at the top and outranks the rest;
/// this is Discord's visual convention with the numeric order inverted.
///
/// Built-ins sit above every custom role: an owner outranks everything, a
/// moderator outranks every custom role but the owner.
pub(crate) async fn role_authority(state: &AppState, room_id: &str, user_id: &str) -> i32 {
    use super::state::CustomRoleRecord;
    use futures_util::TryStreamExt;
    use mongodb::bson::doc;

    match get_user_role(state, room_id, user_id).await.as_str() {
        "owner" => return i32::MIN,
        "moderator" => return i32::MIN + 1,
        _ => {}
    }

    let role_ids = get_user_custom_role_ids(state, room_id, user_id).await;
    if role_ids.is_empty() {
        return i32::MAX;
    }
    let coll = state.db.collection::<CustomRoleRecord>("custom_roles");
    let mut best = i32::MAX;
    if let Ok(mut cursor) = coll
        .find(doc! { "room_id": room_id, "_id": { "$in": &role_ids } })
        .await
    {
        while let Ok(Some(r)) = cursor.try_next().await {
            best = best.min(r.position);
        }
    }
    best
}

/// Whether `user_id` outranks a role at `position`. Strict, so a role can never
/// edit itself or a peer at the same position.
pub(crate) async fn outranks_role(
    state: &AppState,
    room_id: &str,
    user_id: &str,
    position: i32,
) -> bool {
    role_authority(state, room_id, user_id).await < position
}

/// The permissions `user_id` may hand out — you cannot grant what you do not
/// hold. Owners bypass this, since they hold everything by definition.
pub(crate) async fn ungrantable_permission(
    state: &AppState,
    room_id: &str,
    user_id: &str,
    requested: &RolePermissions,
) -> Option<&'static str> {
    if get_user_role(state, room_id, user_id).await == "owner" {
        return None;
    }
    let held = effective_permissions(state, room_id, user_id).await;
    RolePermissions::NAMES
        .into_iter()
        .find(|name| requested.get(name) && !held.get(name))
}

/// A user's permissions inside one channel: the room-level set with the
/// channel's overwrites applied.
///
/// Order follows Discord's, because it is the one people already reason about:
/// the `everyone` overwrite first, then the union of the overwrites for every
/// role the member holds, then the member's own overwrite. Within each step
/// denies are applied before allows, so a more specific allow wins.
///
/// An owner bypasses overwrites entirely — otherwise a room owner could lock
/// themselves out of their own channel with no way back.
pub(crate) async fn channel_permissions(
    state: &AppState,
    room_id: &str,
    channel_id: &str,
    user_id: &str,
) -> RolePermissions {
    use mongodb::bson::doc;

    let base = effective_permissions(state, room_id, user_id).await;
    if channel_id.is_empty() || overwrites_bypassed(state, room_id, user_id).await {
        return base;
    }

    let channels_coll = state.db.collection::<ChannelRecord>("channels");
    let Ok(Some(channel)) = channels_coll
        .find_one(doc! { "_id": channel_id, "room_id": room_id })
        .await
    else {
        return base;
    };

    let category = category_overwrites(state, &channel).await;
    let user_roles = get_user_custom_role_ids(state, room_id, user_id).await;
    apply_overwrites(
        base,
        &merged_overwrites(&category, &channel),
        &user_roles,
        user_id,
    )
}

/// The overwrites a channel inherits from its category, or nothing when the
/// channel has no category or has opted out of inheriting.
pub(crate) async fn category_overwrites(
    state: &AppState,
    channel: &ChannelRecord,
) -> Vec<PermissionOverwrite> {
    use super::state::ChannelCategoryRecord;
    use mongodb::bson::doc;

    if !channel.inherit_category_permissions || channel.category_id.is_empty() {
        return Vec::new();
    }
    let coll = state
        .db
        .collection::<ChannelCategoryRecord>("channel_categories");
    coll.find_one(doc! { "_id": &channel.category_id })
        .await
        .ok()
        .flatten()
        .map(|c| c.overwrites)
        .unwrap_or_default()
}

/// Category rules first, then the channel's own — so a channel refines what it
/// inherits rather than being stuck with it.
pub(crate) fn merged_overwrites(
    category: &[PermissionOverwrite],
    channel: &ChannelRecord,
) -> Vec<PermissionOverwrite> {
    let own = channel_overwrites(channel);
    if category.is_empty() {
        return own;
    }
    let mut merged = category.to_vec();
    merged.extend(own);
    merged
}

/// Owners and moderators are not subject to channel overwrites: an owner must
/// not be able to lock themselves out, and moderators already saw every channel
/// under the `view_roles` rules this replaces.
pub(crate) async fn overwrites_bypassed(state: &AppState, room_id: &str, user_id: &str) -> bool {
    let role = get_user_role(state, room_id, user_id).await;
    role == "owner" || role == "moderator"
}

/// Layer a channel's overwrites over a room-level permission set.
///
/// Order follows Discord's, because it is the one people already reason about:
/// the `everyone` overwrite first, then the union of the overwrites for every
/// role the member holds, then the member's own overwrite. Within each step
/// denies are applied before allows, so a more specific allow wins.
pub(crate) fn apply_overwrites(
    base: RolePermissions,
    overwrites: &[PermissionOverwrite],
    user_roles: &[String],
    user_id: &str,
) -> RolePermissions {
    if overwrites.is_empty() {
        return base;
    }

    fn apply(perms: &mut RolePermissions, allow: &[String], deny: &[String]) {
        for name in deny {
            perms.set(name, false);
        }
        for name in allow {
            perms.set(name, true);
        }
    }

    let mut perms = base;

    for ow in overwrites.iter().filter(|o| o.target_type == "everyone") {
        apply(&mut perms, &ow.allow, &ow.deny);
    }

    // Roles are unioned before they are applied, so holding two roles cannot
    // let the order of the list decide the outcome.
    if !user_roles.is_empty() {
        let mut allow: Vec<String> = Vec::new();
        let mut deny: Vec<String> = Vec::new();
        for ow in overwrites
            .iter()
            .filter(|o| o.target_type == "role" && user_roles.contains(&o.target_id))
        {
            allow.extend(ow.allow.iter().cloned());
            deny.extend(ow.deny.iter().cloned());
        }
        apply(&mut perms, &allow, &deny);
    }

    for ow in overwrites
        .iter()
        .filter(|o| o.target_type == "user" && o.target_id == user_id)
    {
        apply(&mut perms, &ow.allow, &ow.deny);
    }

    perms
}

/// A channel's overwrites, including any still expressed as the legacy
/// `view_roles` / `write_roles` arrays. Channels are migrated at startup, so
/// this fallback only matters for records written by an older build.
pub(crate) fn channel_overwrites(channel: &ChannelRecord) -> Vec<PermissionOverwrite> {
    if channel.overwrites_migrated
        || (channel.view_roles.is_empty() && channel.write_roles.is_empty())
    {
        return channel.overwrites.clone();
    }
    let mut out = channel.overwrites.clone();
    out.extend(legacy_role_overwrites(
        &channel.view_roles,
        &channel.write_roles,
    ));
    out
}

/// "only these roles may view/write" becomes "deny everyone, allow those roles".
pub(crate) fn legacy_role_overwrites(
    view_roles: &[String],
    write_roles: &[String],
) -> Vec<PermissionOverwrite> {
    let mut out: Vec<PermissionOverwrite> = Vec::new();
    let mut everyone_deny: Vec<String> = Vec::new();
    if !view_roles.is_empty() {
        everyone_deny.push("view_channel".to_string());
    }
    if !write_roles.is_empty() {
        everyone_deny.push("send_messages".to_string());
    }
    if everyone_deny.is_empty() {
        return out;
    }
    out.push(PermissionOverwrite {
        target_type: "everyone".to_string(),
        target_id: String::new(),
        allow: Vec::new(),
        deny: everyone_deny,
    });
    for role_id in view_roles {
        out.push(PermissionOverwrite {
            target_type: "role".to_string(),
            target_id: role_id.clone(),
            allow: vec!["view_channel".to_string()],
            deny: Vec::new(),
        });
    }
    for role_id in write_roles {
        out.push(PermissionOverwrite {
            target_type: "role".to_string(),
            target_id: role_id.clone(),
            allow: vec!["send_messages".to_string()],
            deny: Vec::new(),
        });
    }
    out
}

/// Returns the set of channel IDs the user is allowed to see in a room.
/// Returns None if the user is an owner or moderator (can see all channels).
/// Returns Some(ids) for regular members — only channels with empty view_roles
/// or where the user holds a matching custom role.
pub(crate) async fn get_allowed_channel_ids(
    state: &AppState,
    room_id: &str,
    user_id: &str,
) -> Option<Vec<String>> {
    use futures_util::TryStreamExt;
    use mongodb::bson::doc;

    if overwrites_bypassed(state, room_id, user_id).await {
        return None; // privileged: unrestricted access
    }
    use super::state::ChannelCategoryRecord;
    use std::collections::HashMap;

    let base = effective_permissions(state, room_id, user_id).await;
    let user_roles = get_user_custom_role_ids(state, room_id, user_id).await;

    // One pass for the categories rather than a lookup per channel.
    let mut categories: HashMap<String, Vec<PermissionOverwrite>> = HashMap::new();
    let cat_coll = state
        .db
        .collection::<ChannelCategoryRecord>("channel_categories");
    if let Ok(mut cursor) = cat_coll.find(doc! { "room_id": room_id }).await {
        while let Ok(Some(cat)) = cursor.try_next().await {
            categories.insert(cat.category_id.clone(), cat.overwrites);
        }
    }

    let channels_coll = state.db.collection::<ChannelRecord>("channels");
    let mut allowed = Vec::new();
    if let Ok(mut cursor) = channels_coll.find(doc! { "room_id": room_id }).await {
        while let Ok(Some(ch)) = cursor.try_next().await {
            let inherited = if ch.inherit_category_permissions {
                categories.get(&ch.category_id).cloned().unwrap_or_default()
            } else {
                Vec::new()
            };
            let perms = apply_overwrites(
                base,
                &merged_overwrites(&inherited, &ch),
                &user_roles,
                user_id,
            );
            if perms.view_channel {
                allowed.push(ch.channel_id.clone());
            }
        }
    }
    Some(allowed)
}

// ─── Session cookies ─────────────────────────────────────────────────────────

/// Build `Set-Cookie` response headers that install the two session cookies:
///
/// * `refresh_token`  — HttpOnly; SameSite=Strict; Path=/;         7-day lifetime
/// * `media_session`  — HttpOnly; SameSite=Strict; Path=/external; 15-min lifetime
///
/// `media_session` scoped to `/external` is sent automatically by browsers for
/// `<video>`/`<audio>` elements pointing at `/external/*`, eliminating the need
/// for `?access_token=…` query parameters.  Add the `Secure` attribute when
/// serving over HTTPS.
pub(crate) fn auth_cookie_headers(access_token: &str, refresh_token: &str) -> HeaderMap {
    let mut m = HeaderMap::new();
    m.append(
        header::SET_COOKIE,
        HeaderValue::from_str(&format!(
            "refresh_token={}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800",
            refresh_token
        ))
        .unwrap(),
    );
    m.append(
        header::SET_COOKIE,
        HeaderValue::from_str(&format!(
            "media_session={}; HttpOnly; SameSite=Strict; Path=/external; Max-Age=900",
            access_token
        ))
        .unwrap(),
    );
    m
}

/// Build `Set-Cookie` headers that expire both session cookies immediately (logout).
pub(crate) fn clear_cookie_headers() -> HeaderMap {
    let mut m = HeaderMap::new();
    m.append(
        header::SET_COOKIE,
        HeaderValue::from_static("refresh_token=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"),
    );
    m.append(
        header::SET_COOKIE,
        HeaderValue::from_static(
            "media_session=; HttpOnly; SameSite=Strict; Path=/external; Max-Age=0",
        ),
    );
    m
}

/// Extract the `refresh_token` value from the `Cookie` request header.
pub(crate) fn extract_refresh_cookie(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| {
            s.split(';').find_map(|part| {
                let part = part.trim();
                part.strip_prefix("refresh_token=").map(String::from)
            })
        })
}

/// Broadcast a JSON value to all WebSocket-connected members of a room.
/// Uses the write-through room_members cache (no DB call).
pub(crate) async fn broadcast_to_room(state: &AppState, room_id: &str, message: &Value) {
    let members = {
        let rm = state.room_members.read().await;
        match rm.get(room_id) {
            Some(m) => m.clone(),
            None => return,
        }
    };
    let text = message.to_string();
    let ws_map = state.active_websockets.read().await;
    for uid in &members {
        if let Some(conns) = ws_map.get(uid) {
            for tx in conns.values() {
                let _ = tx.send(Message::Text(text.clone().into()));
            }
        }
    }
}

/// Broadcast a JSON value only to WebSocket-connected users currently in a
/// specific voice channel. Used to scope events like publisher_ready so
/// users in other channels are not mistakenly notified.
pub(crate) async fn broadcast_to_voice_channel(
    state: &AppState,
    channel_id: &str,
    message: &Value,
) {
    let members: Vec<String> = {
        let vc = state.voice_channels.read().await;
        match vc.get(channel_id) {
            Some(m) => m.keys().cloned().collect(),
            None => return,
        }
    };
    let text = message.to_string();
    let ws_map = state.active_websockets.read().await;
    for uid in &members {
        if let Some(conns) = ws_map.get(uid) {
            for tx in conns.values() {
                let _ = tx.send(Message::Text(text.clone().into()));
            }
        }
    }
}

/// Find the channel marked as `system_channel` for a room (if any).
/// Returns the channel_id if one exists.
pub(crate) async fn get_system_channel_id(state: &AppState, room_id: &str) -> Option<String> {
    let coll = state.db.collection::<ChannelRecord>("channels");
    if let Ok(Some(ch)) = coll
        .find_one(mongodb::bson::doc! { "room_id": room_id, "system_channel": true })
        .await
    {
        Some(ch.channel_id)
    } else {
        None
    }
}

/// Join a user to a room, broadcasting member join + system message.
/// Updates both MongoDB and the in-memory cache.
/// Returns Ok(true) if newly added, Ok(false) if already a member, Err if banned.
pub(crate) async fn do_join_room(
    state: &AppState,
    room_id: &str,
    user_id: &str,
) -> Result<bool, &'static str> {
    // Check ban list
    {
        let banned = state.banned_users.read().await;
        if banned
            .get(room_id)
            .map(|list| list.contains(&user_id.to_string()))
            .unwrap_or(false)
        {
            return Err("You are banned from this room");
        }
    }

    // Check cache first
    let need_add = {
        let rm = state.room_members.read().await;
        match rm.get(room_id) {
            Some(members) => !members.contains(&user_id.to_string()),
            None => true,
        }
    };

    if !need_add {
        return Ok(false);
    }

    // Insert into MongoDB
    let collection = state.db.collection::<RoomMemberRecord>("room_members");
    let record = RoomMemberRecord {
        room_id: room_id.to_string(),
        user_id: user_id.to_string(),
        role: "member".to_string(),
        joined_at: now_millis(),
    };
    // Use insert, ignore duplicate errors
    let _ = collection.insert_one(record).await;

    // Update caches
    {
        let mut rm = state.room_members.write().await;
        let members = rm.entry(room_id.to_string()).or_default();
        if !members.contains(&user_id.to_string()) {
            members.push(user_id.to_string());
        }
    }
    {
        let mut roles = state.room_roles.write().await;
        roles
            .entry(room_id.to_string())
            .or_default()
            .insert(user_id.to_string(), "member".to_string());
    }

    // Broadcast join events
    let event = json!({
        "type": "m.room.member",
        "room_id": room_id,
        "sender": user_id,
        "content": {"membership": "join", "role": "member"},
        "event_id": generate_id("$"),
        "origin_server_ts": now_millis()
    });
    broadcast_to_room(state, room_id, &event).await;

    let display = user_id
        .split(':')
        .next()
        .unwrap_or(user_id)
        .trim_start_matches('@');
    let mut sys_event = json!({
        "type": "m.room.message",
        "room_id": room_id,
        "sender": user_id,
        "content": {
            "msgtype": "m.system",
            "body": format!("{} has joined the room", display)
        },
        "event_id": generate_id("$"),
        "origin_server_ts": now_millis()
    });

    // Route to system channel if one is configured
    if let Some(sys_ch) = get_system_channel_id(state, room_id).await {
        sys_event["channel_id"] = json!(sys_ch);
    }

    // Store system message in MongoDB
    let msg_collection = state.db.collection::<mongodb::bson::Document>("messages");
    if let Ok(doc) = mongodb::bson::to_document(&sys_event) {
        let _ = msg_collection.insert_one(doc).await;
    }

    broadcast_to_room(state, room_id, &sys_event).await;
    Ok(true)
}

/// Send a JSON message to one specific connection of a user.
///
/// `send_to_user` fans out to every device they have open, which is wrong for
/// anything addressed to the device that did something — telling all of them
/// that their voice session was taken over would tell the device that took it.
pub(crate) async fn send_to_conn(state: &AppState, user_id: &str, conn_id: u64, message: &Value) {
    let ws_map = state.active_websockets.read().await;
    if let Some(tx) = ws_map.get(user_id).and_then(|conns| conns.get(&conn_id)) {
        let _ = tx.send(Message::Text(message.to_string().into()));
    }
}

/// Send a JSON message to a single WebSocket-connected user (all their active connections).
pub(crate) async fn send_to_user(state: &AppState, user_id: &str, message: &Value) {
    let ws_map = state.active_websockets.read().await;
    if let Some(conns) = ws_map.get(user_id) {
        let text = message.to_string();
        for tx in conns.values() {
            let _ = tx.send(Message::Text(text.clone().into()));
        }
    }
}

/// Batch-query thread reply counts for multiple event IDs.
/// Returns a map from event_id -> reply_count.
pub(crate) async fn get_thread_counts_for_events(
    state: &AppState,
    event_ids: &[String],
) -> std::collections::HashMap<String, u64> {
    use futures_util::TryStreamExt;
    use mongodb::bson::doc;

    let mut result: std::collections::HashMap<String, u64> = std::collections::HashMap::new();

    if event_ids.is_empty() {
        return result;
    }

    let msg_coll = state.db.collection::<mongodb::bson::Document>("messages");
    let bson_ids: Vec<mongodb::bson::Bson> = event_ids
        .iter()
        .map(|id| mongodb::bson::Bson::String(id.clone()))
        .collect();

    if let Ok(mut cursor) = msg_coll
        .find(doc! { "thread_id": { "$in": bson_ids } })
        .await
    {
        while let Ok(Some(doc)) = cursor.try_next().await {
            if let Ok(thread_id) = doc.get_str("thread_id") {
                *result.entry(thread_id.to_string()).or_insert(0) += 1;
            }
        }
    }

    result
}

/// Batch-query reactions for multiple event IDs.
/// Returns a map from event_id -> { emoji -> [user_id, ...] }.
pub(crate) async fn get_reactions_for_events(
    state: &AppState,
    event_ids: &[String],
) -> std::collections::HashMap<String, std::collections::HashMap<String, Vec<String>>> {
    use futures_util::TryStreamExt;
    use mongodb::bson::doc;

    let mut result: std::collections::HashMap<
        String,
        std::collections::HashMap<String, Vec<String>>,
    > = std::collections::HashMap::new();

    if event_ids.is_empty() {
        return result;
    }

    let react_coll = state.db.collection::<ReactionRecord>("reactions");
    let bson_ids: Vec<mongodb::bson::Bson> = event_ids
        .iter()
        .map(|id| mongodb::bson::Bson::String(id.clone()))
        .collect();

    if let Ok(mut cursor) = react_coll
        .find(doc! { "event_id": { "$in": bson_ids } })
        .await
    {
        while let Ok(Some(record)) = cursor.try_next().await {
            result
                .entry(record.event_id)
                .or_default()
                .entry(record.emoji)
                .or_default()
                .push(record.user_id);
        }
    }

    result
}
