use super::{
    constants::{MAX_USERNAME_LENGTH, MIN_USERNAME_LENGTH},
    state::{
        AppState, ChannelRecord, PermissionOverwrite, PresenceRecord, ReactionRecord,
        RolePermissions, RoomMemberRecord, UploadRecord,
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
use std::collections::HashSet;
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

/// Whether either of two users has blocked the other.
///
/// Blocking is checked in both directions on purpose: the point of it is that
/// the two of them stop reaching each other, and a rule that only stopped the
/// blocked party would let the blocker keep opening conversations with someone
/// who has no way to answer.
pub(crate) async fn is_blocked_between(state: &AppState, a: &str, b: &str) -> bool {
    use super::state::BlockRecord;
    use mongodb::bson::doc;
    state
        .db
        .collection::<BlockRecord>("blocks")
        .find_one(doc! { "$or": [
            { "blocker": a, "blocked": b },
            { "blocker": b, "blocked": a },
        ]})
        .await
        .ok()
        .flatten()
        .is_some()
}

/// Escape regex metacharacters so a value is matched literally.
///
/// Anything user-supplied that reaches a `$regex` has to come through here.
/// Unescaped it is two bugs at once: searching for `a.b` quietly matches
/// `axb`, and a crafted pattern like `(a+)+b` makes the server walk a whole
/// room's messages backtracking on each one.
pub(crate) fn regex_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if "\\.+*?()|[]{}^$".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// The `@name` a message body would contain to mention this user.
///
/// Shared by the unread mention counts and by push delivery, so both agree on
/// what being mentioned looks like.
pub(crate) fn mention_token(user_id: &str) -> String {
    let local = user_id
        .split(':')
        .next()
        .unwrap_or(user_id)
        .trim_start_matches('@');
    format!("@{local}")
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

/// Whether a string has the shape of a theme share code.
///
/// Deliberately shallow: the payload is base64url that only the client decodes,
/// and duplicating that decoder here would be a second implementation to keep
/// in step. What this does stop is an unbounded or oddly-charactered string
/// being stored on a room and broadcast to everyone in it.
pub(crate) fn valid_theme_share_code(code: &str) -> bool {
    const MAX_SHARE_CODE_LEN: usize = 512;
    code.len() > 4
        && code.len() <= MAX_SHARE_CODE_LEN
        && code.starts_with("ct1_")
        && code[4..]
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Whether a string is safe to use as a custom name font.
///
/// The value ends up interpolated into a stylesheet on every client that
/// renders the person's name — `url('<here>')` — so an unchecked one is not a
/// bad link, it is a CSS injection into everybody else's page: close the
/// quote and the rule and the rest of the string is arbitrary CSS, which
/// reads attributes back out through selectors and can cover the UI with
/// anything it likes. It reached that sink verbatim, and the upload URL keeps
/// literal `'` and `(` in a filename, so a crafted upload was enough.
///
/// Fonts are uploaded to this instance and referred to by the URL that upload
/// answered with, so the shape is known: same-origin, under `/external/`, and
/// free of the characters that end a CSS string or a rule.
pub(crate) fn valid_name_font_url(url: &str) -> bool {
    const MAX_FONT_URL_LEN: usize = 512;
    if url.is_empty() {
        return true; // clearing the font
    }
    if url.len() > MAX_FONT_URL_LEN {
        return false;
    }
    // Nothing that can leave the `url('…')` string, end the declaration, or
    // start a comment.
    if url
        .chars()
        .any(|c| c.is_whitespace() || c.is_control() || "'\"\\();{}<>".contains(c))
    {
        return false;
    }

    let path = if let Some(rest) = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
    {
        // Absolute form: skip the authority, judge the path.
        match rest.find('/') {
            Some(i) => &rest[i..],
            None => return false,
        }
    } else {
        url
    };

    path.starts_with("/external/") && !path.contains("..")
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

/// A 429 that says how long to wait. A limit which only says "no" is
/// indistinguishable from a bug, so the wait is always included.
pub(crate) fn rate_limited(retry_after: f64, detail: &str) -> (StatusCode, Json<Value>) {
    let secs = super::ratelimit::retry_after_secs(retry_after);
    (
        StatusCode::TOO_MANY_REQUESTS,
        Json(serde_json::json!({
            "error": detail,
            "errcode": "M_LIMIT_EXCEEDED",
            "retry_after_secs": secs,
        })),
    )
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
/// Whether a channel is open to the room at large.
///
/// The "everyone" layer only — no member, no roles, no owner/moderator bypass.
/// That is deliberate and differs from `get_allowed_channel_ids`, which answers
/// "may *this caller* see it". A moderator can open a private channel, but a
/// call happening in one is still not something to advertise on a room's badge:
/// public has to mean the same thing to everybody, or the badge says something
/// different depending on who is looking at it.
///
/// Legacy `view_roles` are covered too, because `merged_overwrites` folds them
/// in through `channel_overwrites` — a channel restricted the old way denies
/// `view_channel` to everyone, so it is not public either.
/// Whether a user's badge should read "on mobile": they are connected, and
/// every connection they hold is a phone.
///
/// "Every", not "any". The badge tells other people where they can be reached;
/// someone sitting at a desktop with their phone also logged in is at a
/// keyboard, and a phone icon on them is a lie. It also means closing the
/// phone revises the badge immediately instead of waiting for the desktop to
/// go too.
pub(crate) fn is_mobile_only(live_conn_ids: &[u64], mobile_conn_ids: &HashSet<u64>) -> bool {
    !live_conn_ids.is_empty() && live_conn_ids.iter().all(|id| mobile_conn_ids.contains(id))
}

/// The status string a presence record resolves to, as every caller reports it.
pub(crate) fn presence_status(presence: &PresenceRecord, now: f64) -> &str {
    if !presence.connected {
        "offline"
    } else if let Some(ref manual) = presence.manual_status {
        manual.as_str()
    } else if now - presence.last_active < IDLE_AFTER_SECS {
        "active"
    } else {
        "idle"
    }
}

/// How long without activity before a connected user reads as idle.
pub(crate) const IDLE_AFTER_SECS: f64 = 300.0;

pub(crate) fn channel_is_public(
    category_overwrites: &[PermissionOverwrite],
    channel: &ChannelRecord,
) -> bool {
    let empty: Vec<PermissionOverwrite> = Vec::new();
    let inherited = if channel.inherit_category_permissions {
        category_overwrites
    } else {
        &empty
    };
    // Filtered rather than passed an empty user id: a "user" overwrite that
    // happened to carry an empty target would otherwise apply to nobody's
    // permissions and still change the answer.
    let everyone: Vec<PermissionOverwrite> = merged_overwrites(inherited, channel)
        .into_iter()
        .filter(|o| o.target_type == "everyone")
        .collect();
    apply_overwrites(RolePermissions::default(), &everyone, &[], "").view_channel
}

/// The channels in a room that `channel_is_public` accepts.
pub(crate) async fn public_channel_ids(
    state: &AppState,
    room_id: &str,
) -> std::collections::HashSet<String> {
    use super::state::ChannelCategoryRecord;
    use futures_util::TryStreamExt;
    use mongodb::bson::doc;
    use std::collections::{HashMap, HashSet};

    let mut categories: HashMap<String, Vec<PermissionOverwrite>> = HashMap::new();
    let cat_coll = state
        .db
        .collection::<ChannelCategoryRecord>("channel_categories");
    if let Ok(mut cursor) = cat_coll.find(doc! { "room_id": room_id }).await {
        while let Ok(Some(cat)) = cursor.try_next().await {
            categories.insert(cat.category_id.clone(), cat.overwrites);
        }
    }

    let mut public = HashSet::new();
    let channels_coll = state.db.collection::<ChannelRecord>("channels");
    if let Ok(mut cursor) = channels_coll.find(doc! { "room_id": room_id }).await {
        while let Ok(Some(ch)) = cursor.try_next().await {
            let inherited = categories.get(&ch.category_id).cloned().unwrap_or_default();
            if channel_is_public(&inherited, &ch) {
                public.insert(ch.channel_id.clone());
            }
        }
    }
    public
}

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

/// URLs appearing in a message body.
///
/// Attachments travel as bare links in the body rather than as structured
/// content, so this is the only place a message says what media it carries.
/// Trailing punctuation is trimmed because a link written into a sentence
/// collects it, and the stored URL never has any.
pub(crate) fn media_urls_in_body(body: &str) -> Vec<String> {
    body.split_whitespace()
        .filter(|token| token.starts_with("http://") || token.starts_with("https://"))
        .map(|token| token.trim_end_matches([',', '.', ')', ']', '!', '?', ';', ':']))
        .filter(|token| !token.is_empty())
        .map(String::from)
        .collect()
}

/// Batch-query pixel dimensions for uploaded media, keyed by URL.
///
/// Sent alongside a page of messages so the client can reserve each image's
/// space before loading it. One query per page rather than one per image: a
/// reader scrolling through history cannot wait on a round trip per attachment,
/// which is the whole point of knowing the size in advance.
pub(crate) async fn get_media_dimensions_for_urls(
    state: &AppState,
    urls: &[String],
) -> std::collections::HashMap<String, (u32, u32)> {
    use futures_util::TryStreamExt;
    use mongodb::bson::doc;

    let mut result: std::collections::HashMap<String, (u32, u32)> =
        std::collections::HashMap::new();
    if urls.is_empty() {
        return result;
    }

    let uploads = state.db.collection::<UploadRecord>("uploads");
    let bson_urls: Vec<mongodb::bson::Bson> = urls
        .iter()
        .map(|u| mongodb::bson::Bson::String(u.clone()))
        .collect();

    // A zero width is the backfill's record of "measured, not an image", so it
    // is excluded here the same as an unmeasured one.
    if let Ok(mut cursor) = uploads
        .find(doc! { "url": { "$in": bson_urls }, "width": { "$gt": 0 } })
        .await
    {
        while let Ok(Some(record)) = cursor.try_next().await {
            if let (Some(w), Some(h)) = (record.width, record.height) {
                if w > 0 && h > 0 {
                    result.insert(record.url, (w, h));
                }
            }
        }
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn media_urls_reads_links_out_of_a_body() {
        // The composer joins text and uploads with newlines.
        let body = "look at this\nhttps://host/external/a/pic.png";
        assert_eq!(
            media_urls_in_body(body),
            vec!["https://host/external/a/pic.png".to_string()]
        );
    }

    #[test]
    fn media_urls_finds_every_attachment_in_one_message() {
        let body = "https://host/external/a/one.png https://host/external/a/two.png";
        assert_eq!(media_urls_in_body(body).len(), 2);
    }

    #[test]
    fn media_urls_trims_punctuation_a_sentence_leaves_behind() {
        // A link written mid-sentence collects punctuation the stored URL
        // never has, and would otherwise miss its dimensions.
        let body = "see https://host/external/a/pic.png, then https://host/external/a/b.png.";
        assert_eq!(
            media_urls_in_body(body),
            vec![
                "https://host/external/a/pic.png".to_string(),
                "https://host/external/a/b.png".to_string()
            ]
        );
    }

    #[test]
    fn media_urls_ignores_everything_that_is_not_a_link() {
        assert!(media_urls_in_body("no links here at all").is_empty());
        assert!(media_urls_in_body("").is_empty());
        // Not a scheme we serve uploads over, so nothing to look up.
        assert!(media_urls_in_body("ftp://host/pic.png").is_empty());
    }

    fn overwrite(
        target_type: &str,
        target_id: &str,
        allow: &[&str],
        deny: &[&str],
    ) -> PermissionOverwrite {
        PermissionOverwrite {
            target_type: target_type.to_string(),
            target_id: target_id.to_string(),
            allow: allow.iter().map(|s| s.to_string()).collect(),
            deny: deny.iter().map(|s| s.to_string()).collect(),
        }
    }

    fn voice_channel(overwrites: Vec<PermissionOverwrite>) -> ChannelRecord {
        ChannelRecord {
            channel_id: "chan-1".to_string(),
            room_id: "room-a".to_string(),
            name: "General".to_string(),
            channel_type: "voice".to_string(),
            topic: String::new(),
            position: 0,
            category_id: "cat-1".to_string(),
            read_only: false,
            slowmode_secs: 0,
            overwrites,
            inherit_category_permissions: true,
            view_roles: Vec::new(),
            write_roles: Vec::new(),
            overwrites_migrated: true,
            showcase_write_roles: Vec::new(),
            showcase_posters: Vec::new(),
            system_channel: false,
            bot_id: String::new(),
            voice_bitrate: 64_000,
            created_by: "@a:h".to_string(),
            created_at: 0,
        }
    }

    fn presence(connected: bool, last_active_ago: f64, manual: Option<&str>) -> PresenceRecord {
        PresenceRecord {
            last_active: 1_000.0 - last_active_ago,
            last_typing: 0.0,
            connected,
            custom_status: String::new(),
            manual_status: manual.map(|m| m.to_string()),
            is_mobile: false,
            steam_game: None,
            steam_appid: None,
            game_session_start: None,
            spotify_track: None,
            spotify_artist: None,
            spotify_album_art: None,
        }
    }

    #[test]
    fn a_lone_phone_reads_as_mobile() {
        let mobile: HashSet<u64> = [1].into_iter().collect();
        assert!(is_mobile_only(&[1], &mobile));
    }

    #[test]
    fn a_desktop_alongside_a_phone_is_not_mobile() {
        // The badge says where someone can be reached. With a desktop session
        // open they are at a keyboard, whatever else is logged in.
        let mobile: HashSet<u64> = [1].into_iter().collect();
        assert!(!is_mobile_only(&[1, 2], &mobile));
    }

    #[test]
    fn closing_the_desktop_leaves_them_on_mobile() {
        let mobile: HashSet<u64> = [1].into_iter().collect();
        assert!(!is_mobile_only(&[1, 2], &mobile));
        // ...and the phone is all that is left.
        assert!(is_mobile_only(&[1], &mobile));
    }

    #[test]
    fn closing_the_phone_clears_it_while_the_desktop_stays() {
        // The regression: this used to keep saying mobile until every device
        // had disconnected, because only the last one out revised the flag.
        let mobile: HashSet<u64> = [1].into_iter().collect();
        assert!(!is_mobile_only(&[2], &mobile));
    }

    #[test]
    fn no_connections_is_never_mobile() {
        let mobile: HashSet<u64> = [1, 2].into_iter().collect();
        assert!(!is_mobile_only(&[], &mobile));
    }

    #[test]
    fn status_is_offline_whenever_disconnected() {
        // Even with a manual status set, and even if they were active a second
        // ago: no connection is no presence.
        assert_eq!(
            presence_status(&presence(false, 1.0, Some("dnd")), 1_000.0),
            "offline"
        );
    }

    #[test]
    fn a_manual_status_outranks_activity() {
        assert_eq!(
            presence_status(&presence(true, 1.0, Some("dnd")), 1_000.0),
            "dnd"
        );
    }

    #[test]
    fn activity_decides_when_nothing_is_set_manually() {
        assert_eq!(
            presence_status(&presence(true, 1.0, None), 1_000.0),
            "active"
        );
        assert_eq!(
            presence_status(&presence(true, IDLE_AFTER_SECS + 1.0, None), 1_000.0),
            "idle"
        );
    }

    #[test]
    fn a_channel_with_no_overwrites_is_public() {
        assert!(channel_is_public(&[], &voice_channel(Vec::new())));
    }

    #[test]
    fn denying_everyone_makes_a_channel_private() {
        let ch = voice_channel(vec![overwrite("everyone", "", &[], &["view_channel"])]);
        assert!(!channel_is_public(&[], &ch));
    }

    #[test]
    fn a_role_that_can_see_a_private_channel_does_not_make_it_public() {
        // The usual shape of a private channel: shut to everyone, opened for
        // one role. Whoever holds that role can see the call; the room at
        // large cannot, so the room's badge must stay dark.
        let ch = voice_channel(vec![
            overwrite("everyone", "", &[], &["view_channel"]),
            overwrite("role", "role-mods", &["view_channel"], &[]),
        ]);
        assert!(!channel_is_public(&[], &ch));
    }

    #[test]
    fn a_member_granted_access_does_not_make_it_public() {
        let ch = voice_channel(vec![
            overwrite("everyone", "", &[], &["view_channel"]),
            overwrite("user", "@a:h", &["view_channel"], &[]),
        ]);
        assert!(!channel_is_public(&[], &ch));
    }

    #[test]
    fn a_private_category_carries_down_to_a_channel_that_inherits() {
        let category = vec![overwrite("everyone", "", &[], &["view_channel"])];
        assert!(!channel_is_public(&category, &voice_channel(Vec::new())));
    }

    #[test]
    fn a_channel_that_opts_out_of_its_category_is_judged_alone() {
        let category = vec![overwrite("everyone", "", &[], &["view_channel"])];
        let mut ch = voice_channel(Vec::new());
        ch.inherit_category_permissions = false;
        assert!(channel_is_public(&category, &ch));
    }

    #[test]
    fn a_channel_can_reopen_what_its_category_shut() {
        let category = vec![overwrite("everyone", "", &[], &["view_channel"])];
        let ch = voice_channel(vec![overwrite("everyone", "", &["view_channel"], &[])]);
        assert!(channel_is_public(&category, &ch));
    }

    #[test]
    fn a_legacy_view_roles_channel_is_private() {
        // Restricted before overwrites existed and never migrated: the roles
        // are folded into an everyone-deny, so this reads as private too.
        let mut ch = voice_channel(Vec::new());
        ch.overwrites_migrated = false;
        ch.view_roles = vec!["role-mods".to_string()];
        assert!(!channel_is_public(&[], &ch));
    }

    /// The filter `is_blocked_between` builds, without needing a database.
    fn block_filter(a: &str, b: &str) -> mongodb::bson::Document {
        mongodb::bson::doc! { "$or": [
            { "blocker": a, "blocked": b },
            { "blocker": b, "blocked": a },
        ]}
    }

    #[test]
    fn a_block_is_checked_in_both_directions() {
        // Blocking exists so the two of them stop reaching each other. A rule
        // that only stopped the blocked party would let the blocker keep
        // opening conversations with someone who cannot answer.
        let forward = block_filter("@a:h", "@b:h");
        let reverse = block_filter("@b:h", "@a:h");
        let clauses = forward.get_array("$or").unwrap();
        assert_eq!(clauses.len(), 2);
        // The same pair produces the same two clauses whichever way round the
        // arguments come in, just swapped.
        let as_pairs = |d: &mongodb::bson::Document| {
            let mut pairs: Vec<(String, String)> = d
                .get_array("$or")
                .unwrap()
                .iter()
                .map(|c| {
                    let c = c.as_document().unwrap();
                    (
                        c.get_str("blocker").unwrap().to_string(),
                        c.get_str("blocked").unwrap().to_string(),
                    )
                })
                .collect();
            pairs.sort();
            pairs
        };
        assert_eq!(as_pairs(&forward), as_pairs(&reverse));
    }

    #[test]
    fn regex_escape_neutralizes_metacharacters() {
        assert_eq!(regex_escape("@a.b"), "@a\\.b");
        assert_eq!(regex_escape("@a+b(c)"), "@a\\+b\\(c\\)");
        assert_eq!(regex_escape("@plain"), "@plain");
        // The shape that makes a regex engine backtrack forever.
        assert_eq!(regex_escape("(a+)+b"), "\\(a\\+\\)\\+b");
    }

    #[test]
    fn mention_token_uses_the_localpart() {
        assert_eq!(mention_token("@buck:localhost"), "@buck");
        assert_eq!(mention_token("buck"), "@buck");
    }

    #[test]
    fn name_font_url_accepts_what_an_upload_answers_with() {
        assert!(valid_name_font_url(""));
        assert!(valid_name_font_url("/external/a1b2/My%20Font.woff2"));
        assert!(valid_name_font_url(
            "https://chat.example/external/a1b2/font.ttf"
        ));
        assert!(valid_name_font_url(
            "http://localhost:8000/external/a1b2/font.otf"
        ));
    }

    #[test]
    fn name_font_url_rejects_an_escape_from_the_css_string() {
        // The payload this exists for: close the url(), close the rule, and
        // the rest is CSS in every viewer's page.
        assert!(!valid_name_font_url(
            "/external/a/f.ttf'); } :root { --x: url('https://evil/x"
        ));
        assert!(!valid_name_font_url("/external/a/f.ttf\"); }"));
        assert!(!valid_name_font_url("/external/a/f(x).ttf"));
        assert!(!valid_name_font_url("/external/a/f.ttf; color: red"));
        assert!(!valid_name_font_url("/external/a/ f.ttf"));
    }

    #[test]
    fn name_font_url_stays_on_this_server() {
        assert!(!valid_name_font_url("https://evil.example/font.ttf"));
        assert!(!valid_name_font_url("/etc/passwd"));
        assert!(!valid_name_font_url("/external/../../etc/passwd"));
        assert!(!valid_name_font_url("javascript:alert(1)"));
        assert!(!valid_name_font_url(&format!(
            "/external/a/{}.ttf",
            "x".repeat(600)
        )));
    }
}
