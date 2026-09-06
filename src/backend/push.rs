//! Web Push delivery for members who are not connected.
//!
//! A connected client raises its own notification straight off the WebSocket
//! event, so push exists only for the case that path cannot reach: the tab is
//! closed, the phone is asleep, the socket is gone. An active connection is
//! therefore the switch between the two — a member with one is never pushed to,
//! which is also what keeps a message from arriving twice.
//!
//! The rules deciding whether a message is worth waking someone for are the
//! same rules the client applies. They are ported here from
//! `client/src/lib/notifications.ts` rather than re-invented, so a muted
//! channel stays muted on a phone; the two must be changed together.

use super::{
    helpers::{get_allowed_channel_ids, mention_token, now_secs},
    state::{AppState, CustomRoleRecord, MemberCustomRoleRecord, UserRecord},
    webpush,
};
use futures_util::TryStreamExt;
use mongodb::bson::{doc, Document};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{collections::HashMap, sync::Arc};

/// How long a push service should hold a notification for a device that is
/// offline. A chat message is stale long before this, but dropping it entirely
/// because a phone was in a tunnel is worse than showing it late.
const PUSH_TTL_SECS: u32 = 12 * 60 * 60;

/// Payloads are capped at 4KB by the push services; the body is trimmed well
/// under that so the surrounding JSON always fits.
const MAX_BODY_CHARS: usize = 140;

// ─── VAPID keys ──────────────────────────────────────────────────────────────

/// The server's application-server identity, as required by RFC 8292.
///
/// The keypair must survive restarts: every subscription a browser holds is
/// bound to the public key it was created with, so a new key on boot would
/// silently invalidate every device already enrolled.
pub(crate) struct VapidKeys {
    /// Base64url (unpadded) raw 32-byte P-256 scalar — the signing key.
    pub(crate) private_key: String,
    /// Base64url (unpadded) uncompressed P-256 point — handed to the browser
    /// as `applicationServerKey`.
    pub(crate) public_key: String,
    /// The VAPID `sub` claim: how a push service can reach this server's
    /// operator. Some services reject a token without one.
    pub(crate) subject: String,
}

/// Derive the public half from a private key, which doubles as a validity
/// check — a malformed key fails here rather than on the first send.
fn public_key_for(private_key: &str) -> Option<String> {
    webpush::public_key_from_private(private_key)
}

/// Load the server's VAPID keypair, generating one on first use.
///
/// An operator-supplied `VAPID_PRIVATE_KEY` wins, so a deployment can hold the
/// key outside the database; otherwise the generated pair is stored alongside
/// the other server settings and reused forever after.
///
/// Returns `None` only when an operator-supplied key cannot be parsed — a
/// misconfiguration worth failing loudly about rather than silently replacing.
pub(crate) async fn load_or_create_vapid_keys(db: &mongodb::Database) -> Option<VapidKeys> {
    let subject = vapid_subject();
    let coll = db.collection::<Document>("server_settings");

    if let Ok(key) = std::env::var("VAPID_PRIVATE_KEY") {
        let key = key.trim().to_string();
        if !key.is_empty() {
            let Some(public_key) = public_key_for(&key) else {
                eprintln!(
                    "VAPID_PRIVATE_KEY is not a valid base64url P-256 private key; push disabled"
                );
                return None;
            };
            return Some(VapidKeys {
                private_key: key,
                public_key,
                subject,
            });
        }
    }

    if let Ok(Some(doc)) = coll.find_one(doc! { "_id": "vapid" }).await {
        if let Ok(key) = doc.get_str("private_key") {
            if let Some(public_key) = public_key_for(key) {
                return Some(VapidKeys {
                    private_key: key.to_string(),
                    public_key,
                    subject,
                });
            }
        }
    }

    // First boot: mint a keypair and keep it.
    let private_key = webpush::generate_private_key();
    let public_key = public_key_for(&private_key)?;
    let _ = coll
        .update_one(
            doc! { "_id": "vapid" },
            doc! { "$set": { "private_key": &private_key } },
        )
        .upsert(true)
        .await;

    Some(VapidKeys {
        private_key,
        public_key,
        subject,
    })
}

/// The `sub` claim: a way to contact whoever runs this instance. Push services
/// want a `mailto:` or an `https:` URL, so the public server URL is used when
/// one is configured.
fn vapid_subject() -> String {
    if let Ok(subject) = std::env::var("VAPID_SUBJECT") {
        let subject = subject.trim();
        if !subject.is_empty() {
            return subject.to_string();
        }
    }
    match std::env::var("SERVER_URL") {
        Ok(url) if url.starts_with("https://") => url,
        _ => "mailto:admin@localhost".to_string(),
    }
}

// ─── Policy (ported from client/src/lib/notifications.ts) ────────────────────

/// The levels a user can choose, mirroring `NotificationLevel` on the client.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum NotificationLevel {
    All,
    Mentions,
    None,
}

impl NotificationLevel {
    fn parse(s: &str) -> Option<Self> {
        match s {
            "all" => Some(Self::All),
            "mentions" => Some(Self::Mentions),
            "none" => Some(Self::None),
            _ => None,
        }
    }
}

/// Applied when neither the channel nor its room has an explicit setting.
/// Mirrors `DEFAULT_NOTIFICATION_LEVEL`.
const DEFAULT_LEVEL: NotificationLevel = NotificationLevel::All;

/// Overrides keyed as the client keys them: `room_id|channel_id`, with an empty
/// channel for a room-wide entry.
fn settings_key(room_id: &str, channel_id: &str) -> String {
    format!("{room_id}|{channel_id}")
}

/// Port of `resolveNotificationLevel`: a channel override wins over its room's
/// setting, which wins over the default. An explicit room-level "none" is
/// therefore still overridable per channel.
fn resolve_level(
    overrides: &HashMap<String, NotificationLevel>,
    room_id: &str,
    channel_id: &str,
) -> NotificationLevel {
    if !channel_id.is_empty() {
        if let Some(level) = overrides.get(&settings_key(room_id, channel_id)) {
            return *level;
        }
    }
    overrides
        .get(&settings_key(room_id, ""))
        .copied()
        .unwrap_or(DEFAULT_LEVEL)
}

/// The inputs `should_push` judges, mirroring `NotifyDecision`.
///
/// `isViewing` has no entry here: a member with no WebSocket cannot be looking
/// at the channel, and one with a socket is never pushed to at all, so the
/// connection check the caller already made stands in for it.
pub(crate) struct PushDecision {
    pub(crate) level: NotificationLevel,
    pub(crate) is_mention: bool,
    /// DMs bypass "all vs mentions": a direct message is always addressed to you.
    pub(crate) is_dm: bool,
    /// The recipient's own status. "dnd" suppresses everything.
    pub(crate) dnd: bool,
}

/// Port of `shouldNotify`.
pub(crate) fn should_push(d: &PushDecision) -> bool {
    if d.dnd {
        return false;
    }
    match d.level {
        NotificationLevel::None => false,
        NotificationLevel::Mentions => d.is_mention || d.is_dm,
        NotificationLevel::All => true,
    }
}

/// Trim a message body to something that reads well in a notification.
/// Port of `notificationBody`.
pub(crate) fn notification_body(body: &str) -> String {
    let collapsed = body.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() > MAX_BODY_CHARS {
        let head: String = collapsed.chars().take(MAX_BODY_CHARS - 1).collect();
        format!("{head}…")
    } else {
        collapsed
    }
}

// ─── Subscriptions ───────────────────────────────────────────────────────────

/// A browser push subscription, as handed over by `PushManager.subscribe`.
///
/// Keyed by the endpoint rather than by user: a browser profile holds exactly
/// one, so re-subscribing — or a different account signing in on the same
/// device — must replace the row instead of accumulating stale ones.
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct PushSubscriptionRecord {
    #[serde(rename = "_id")]
    pub(crate) id: String,
    pub(crate) user_id: String,
    pub(crate) endpoint: String,
    pub(crate) p256dh: String,
    pub(crate) auth: String,
    pub(crate) created_at: i64,
}

/// Stable id for an endpoint. Endpoints are long URLs and are not valid Mongo
/// `_id`s in every case, so they are hashed rather than used directly.
pub(crate) fn subscription_id(endpoint: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(endpoint.as_bytes());
    hex::encode(hasher.finalize())
}

// ─── Delivery ────────────────────────────────────────────────────────────────

/// Everything needed to describe one message to the people who missed it.
pub(crate) struct MessageNotification {
    pub(crate) room_id: String,
    pub(crate) channel_id: String,
    pub(crate) event_id: String,
    pub(crate) sender_id: String,
    pub(crate) sender_name: String,
    pub(crate) room_name: String,
    pub(crate) channel_name: String,
    pub(crate) body: String,
    pub(crate) icon: String,
    pub(crate) is_dm: bool,
    /// Set when the sender lacks `mention_everyone`: the `@role` still renders,
    /// it just must not wake anyone.
    pub(crate) suppress_role_mentions: bool,
}

/// Queue push delivery for a message without making the sender wait on it.
///
/// Delivery talks to third-party push services over the network; holding the
/// send_message response open for that would make every message as slow as the
/// slowest push endpoint.
pub(crate) fn spawn_message_push(state: Arc<AppState>, notification: MessageNotification) {
    if state.vapid.is_none() {
        return;
    }
    tokio::spawn(async move {
        deliver_message(&state, &notification).await;
    });
}

/// Who, of a room's members, should be woken for this message.
async fn deliver_message(state: &Arc<AppState>, n: &MessageNotification) {
    let Some(vapid) = state.vapid.as_ref() else {
        return;
    };

    // Members who are not the sender and hold no connection. Anyone connected
    // is notified by their own client off the WebSocket event.
    let candidates: Vec<String> = {
        let members = {
            let rm = state.room_members.read().await;
            match rm.get(&n.room_id) {
                Some(m) => m.clone(),
                None => return,
            }
        };
        let ws = state.active_websockets.read().await;
        members
            .into_iter()
            .filter(|uid| *uid != n.sender_id)
            .filter(|uid| ws.get(uid).is_none_or(|conns| conns.is_empty()))
            .collect()
    };
    if candidates.is_empty() {
        return;
    }

    // One query each for the three things every candidate is judged against,
    // rather than three per candidate.
    let subscriptions = subscriptions_for(state, &candidates).await;
    if subscriptions.is_empty() {
        return;
    }
    let recipients: Vec<String> = subscriptions.keys().cloned().collect();
    let overrides = notification_overrides_for(state, &recipients).await;
    let dnd = dnd_users(state, &recipients).await;
    let role_names = role_names_by_user(state, &n.room_id, &recipients).await;

    let payload_for = |title: String| {
        json!({
            "title": title,
            "body": notification_body(&n.body),
            "icon": n.icon,
            // One notification per channel — a burst collapses instead of stacking,
            // matching the client's tag.
            "tag": format!("{}|{}", n.room_id, n.channel_id),
            "room_id": n.room_id,
            "channel_id": n.channel_id,
            "event_id": n.event_id,
        })
        .to_string()
    };

    for (user_id, subs) in subscriptions {
        // A member who cannot read the channel must not be told what was said
        // in it, whatever their notification level says.
        if !n.channel_id.is_empty() {
            if let Some(allowed) = get_allowed_channel_ids(state, &n.room_id, &user_id).await {
                if !allowed.contains(&n.channel_id) {
                    continue;
                }
            }
        }

        let is_mention = mentions_user(
            &n.body,
            &user_id,
            role_names.get(&user_id).map(Vec::as_slice).unwrap_or(&[]),
            n.suppress_role_mentions,
        );
        let decision = PushDecision {
            level: resolve_level(
                overrides.get(&user_id).unwrap_or(&HashMap::new()),
                &n.room_id,
                &n.channel_id,
            ),
            is_mention,
            is_dm: n.is_dm,
            dnd: dnd.contains(&user_id),
        };
        if !should_push(&decision) {
            continue;
        }

        let title = if n.is_dm {
            n.sender_name.clone()
        } else if !n.channel_name.is_empty() {
            format!("{} · #{}", n.sender_name, n.channel_name)
        } else {
            format!("{} · {}", n.sender_name, n.room_name)
        };
        let payload = payload_for(title);

        for sub in subs {
            send_one(state, vapid, &sub, payload.as_bytes()).await;
        }
    }
}

/// Encrypt and POST one notification, dropping the subscription when the push
/// service says the browser is gone for good.
async fn send_one(
    state: &Arc<AppState>,
    vapid: &VapidKeys,
    sub: &PushSubscriptionRecord,
    payload: &[u8],
) {
    let (Some(ua_public), Some(auth_secret)) = (
        webpush::b64url_decode(&sub.p256dh),
        webpush::b64url_decode(&sub.auth),
    ) else {
        // The browser gave us something we cannot encrypt to; it will never
        // become valid, so there is no point keeping it.
        prune(state, &sub.id).await;
        return;
    };

    let Ok(body) = webpush::encrypt(payload, &ua_public, &auth_secret) else {
        prune(state, &sub.id).await;
        return;
    };
    let Ok(authorization) = webpush::vapid_authorization(
        &sub.endpoint,
        &vapid.private_key,
        &vapid.subject,
        now_secs() as u64,
    ) else {
        return;
    };

    let response = state
        .http_client
        .post(&sub.endpoint)
        .header("Authorization", authorization)
        .header("Content-Encoding", "aes128gcm")
        .header("Content-Type", "application/octet-stream")
        .header("TTL", PUSH_TTL_SECS.to_string())
        // A chat message is worth waking a sleeping radio for, but not worth
        // overriding a device's battery saver.
        .header("Urgency", "normal")
        .body(body)
        .send()
        .await;

    match response {
        Ok(response) => {
            // 404/410 is the push service saying this endpoint is permanently
            // gone — the browser dropped the subscription without telling us.
            // Anything else may be transient and is left alone.
            let status = response.status();
            if status == reqwest::StatusCode::NOT_FOUND || status == reqwest::StatusCode::GONE {
                prune(state, &sub.id).await;
            }
        }
        Err(_) => {
            // Network failure: the endpoint may well be fine, so keep it.
        }
    }
}

/// Forget a subscription that can never receive again.
async fn prune(state: &AppState, id: &str) {
    let _ = state
        .db
        .collection::<PushSubscriptionRecord>("push_subscriptions")
        .delete_one(doc! { "_id": id })
        .await;
}

// ─── Batch lookups ───────────────────────────────────────────────────────────

/// Every stored subscription for the given users, grouped by user. A user with
/// no subscription simply does not appear.
async fn subscriptions_for(
    state: &AppState,
    user_ids: &[String],
) -> HashMap<String, Vec<PushSubscriptionRecord>> {
    let mut out: HashMap<String, Vec<PushSubscriptionRecord>> = HashMap::new();
    let coll = state
        .db
        .collection::<PushSubscriptionRecord>("push_subscriptions");
    if let Ok(mut cursor) = coll.find(doc! { "user_id": { "$in": user_ids } }).await {
        while let Ok(Some(sub)) = cursor.try_next().await {
            out.entry(sub.user_id.clone()).or_default().push(sub);
        }
    }
    out
}

/// Notification overrides for the given users, keyed by user and then by the
/// same `room|channel` key the client uses.
async fn notification_overrides_for(
    state: &AppState,
    user_ids: &[String],
) -> HashMap<String, HashMap<String, NotificationLevel>> {
    let mut out: HashMap<String, HashMap<String, NotificationLevel>> = HashMap::new();
    let coll = state.db.collection::<Document>("notification_settings");
    if let Ok(mut cursor) = coll.find(doc! { "user_id": { "$in": user_ids } }).await {
        while let Ok(Some(d)) = cursor.try_next().await {
            let (Ok(user_id), Ok(room_id), Ok(level)) = (
                d.get_str("user_id"),
                d.get_str("room_id"),
                d.get_str("level"),
            ) else {
                continue;
            };
            let Some(level) = NotificationLevel::parse(level) else {
                continue;
            };
            let channel_id = d.get_str("channel_id").unwrap_or("");
            out.entry(user_id.to_string())
                .or_default()
                .insert(settings_key(room_id, channel_id), level);
        }
    }
    out
}

/// Users among the given set whose last chosen status was "do not disturb".
///
/// The status is read from the stored `manual_status` rather than from live
/// presence: presence is dropped when the socket goes, and these are by
/// definition users with no socket.
async fn dnd_users(state: &AppState, user_ids: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    let coll = state.db.collection::<UserRecord>("users");
    if let Ok(mut cursor) = coll
        .find(doc! { "_id": { "$in": user_ids }, "manual_status": "dnd" })
        .await
    {
        while let Ok(Some(u)) = cursor.try_next().await {
            out.push(u.user_id);
        }
    }
    out
}

/// The lowercased role names each user answers to in this room — both the
/// built-in role from the members cache and any custom roles assigned.
async fn role_names_by_user(
    state: &AppState,
    room_id: &str,
    user_ids: &[String],
) -> HashMap<String, Vec<String>> {
    let mut out: HashMap<String, Vec<String>> = HashMap::new();

    {
        let roles = state.room_roles.read().await;
        if let Some(room) = roles.get(room_id) {
            for user_id in user_ids {
                if let Some(role) = room.get(user_id) {
                    if role == "owner" || role == "moderator" {
                        out.entry(user_id.clone()).or_default().push(role.clone());
                    }
                }
            }
        }
    }

    let mut names: HashMap<String, String> = HashMap::new();
    if let Ok(mut cursor) = state
        .db
        .collection::<CustomRoleRecord>("custom_roles")
        .find(doc! { "room_id": room_id })
        .await
    {
        while let Ok(Some(r)) = cursor.try_next().await {
            names.insert(r.role_id, r.name.to_lowercase());
        }
    }
    if names.is_empty() {
        return out;
    }

    if let Ok(mut cursor) = state
        .db
        .collection::<MemberCustomRoleRecord>("member_custom_roles")
        .find(doc! { "room_id": room_id, "user_id": { "$in": user_ids } })
        .await
    {
        while let Ok(Some(assignment)) = cursor.try_next().await {
            if let Some(name) = names.get(&assignment.role_id) {
                out.entry(assignment.user_id)
                    .or_default()
                    .push(name.clone());
            }
        }
    }

    out
}

/// Whether a message body mentions this user, directly or through one of their
/// roles. Port of the `isMention` calculation in `wsHandler.ts`.
fn mentions_user(
    body: &str,
    user_id: &str,
    role_names: &[String],
    suppress_role_mentions: bool,
) -> bool {
    if body.contains(&mention_token(user_id)) {
        return true;
    }
    if suppress_role_mentions || role_names.is_empty() {
        return false;
    }
    mentioned_names(body)
        .iter()
        .any(|name| role_names.iter().any(|role| role == name))
}

/// The lowercased `@word` tokens in a body, matching the client's `/@(\w+)/g`.
fn mentioned_names(body: &str) -> Vec<String> {
    let mut out = Vec::new();
    let chars: Vec<char> = body.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '@' {
            let start = i + 1;
            let mut end = start;
            while end < chars.len() && (chars[end].is_alphanumeric() || chars[end] == '_') {
                end += 1;
            }
            if end > start {
                out.push(chars[start..end].iter().collect::<String>().to_lowercase());
            }
            i = end;
        } else {
            i += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn overrides(pairs: &[(&str, &str, NotificationLevel)]) -> HashMap<String, NotificationLevel> {
        pairs
            .iter()
            .map(|(room, channel, level)| (settings_key(room, channel), *level))
            .collect()
    }

    #[test]
    fn default_level_applies_with_no_override() {
        let empty = HashMap::new();
        assert_eq!(resolve_level(&empty, "!r", "#c"), NotificationLevel::All);
    }

    #[test]
    fn channel_override_beats_room_setting() {
        // The common case: a room muted wholesale, with one channel kept loud.
        let o = overrides(&[
            ("!r", "", NotificationLevel::None),
            ("!r", "#c", NotificationLevel::All),
        ]);
        assert_eq!(resolve_level(&o, "!r", "#c"), NotificationLevel::All);
        assert_eq!(resolve_level(&o, "!r", "#other"), NotificationLevel::None);
    }

    #[test]
    fn room_setting_applies_when_channel_has_no_override() {
        let o = overrides(&[("!r", "", NotificationLevel::Mentions)]);
        assert_eq!(resolve_level(&o, "!r", "#c"), NotificationLevel::Mentions);
        // And a room-less message (empty channel) reads the same entry.
        assert_eq!(resolve_level(&o, "!r", ""), NotificationLevel::Mentions);
    }

    #[test]
    fn a_room_wide_entry_is_not_confused_with_a_channel_one() {
        let o = overrides(&[("!r", "#c", NotificationLevel::None)]);
        // Only #c is muted; the room itself still defaults.
        assert_eq!(resolve_level(&o, "!r", "#c"), NotificationLevel::None);
        assert_eq!(resolve_level(&o, "!r", ""), NotificationLevel::All);
    }

    fn decision(
        level: NotificationLevel,
        is_mention: bool,
        is_dm: bool,
        dnd: bool,
    ) -> PushDecision {
        PushDecision {
            level,
            is_mention,
            is_dm,
            dnd,
        }
    }

    #[test]
    fn dnd_suppresses_everything() {
        assert!(!should_push(&decision(
            NotificationLevel::All,
            true,
            true,
            true
        )));
    }

    #[test]
    fn mentions_level_passes_only_mentions_and_dms() {
        assert!(!should_push(&decision(
            NotificationLevel::Mentions,
            false,
            false,
            false
        )));
        assert!(should_push(&decision(
            NotificationLevel::Mentions,
            true,
            false,
            false
        )));
        // A DM is addressed to you whether or not it names you.
        assert!(should_push(&decision(
            NotificationLevel::Mentions,
            false,
            true,
            false
        )));
    }

    #[test]
    fn none_level_suppresses_even_a_dm() {
        assert!(!should_push(&decision(
            NotificationLevel::None,
            true,
            true,
            false
        )));
    }

    #[test]
    fn mentioned_names_reads_at_tokens() {
        assert_eq!(
            mentioned_names("hey @Buck and @mod_team"),
            ["buck", "mod_team"]
        );
        // An email-looking token still yields its word; the client's regex does
        // the same, and a role or user has to match it for anything to happen.
        assert_eq!(mentioned_names("no mentions here"), Vec::<String>::new());
    }

    #[test]
    fn direct_mention_matches_the_localpart() {
        assert!(mentions_user(
            "morning @buck",
            "@buck:localhost",
            &[],
            false
        ));
        assert!(!mentions_user(
            "morning @buckley",
            "@buck2:localhost",
            &[],
            false
        ));
    }

    #[test]
    fn role_mention_matches_a_role_the_user_holds() {
        let roles = vec!["moderator".to_string()];
        assert!(mentions_user("@moderator help", "@a:h", &roles, false));
        // Suppressed role mentions render but must not wake anyone.
        assert!(!mentions_user("@moderator help", "@a:h", &roles, true));
    }

    #[test]
    fn notification_body_collapses_and_trims() {
        assert_eq!(notification_body("  a\n\nb  "), "a b");
        let long = "x".repeat(200);
        let trimmed = notification_body(&long);
        assert_eq!(trimmed.chars().count(), MAX_BODY_CHARS);
        assert!(trimmed.ends_with('…'));
    }

    #[test]
    fn subscription_id_is_stable_per_endpoint() {
        assert_eq!(
            subscription_id("https://a/1"),
            subscription_id("https://a/1")
        );
        assert_ne!(
            subscription_id("https://a/1"),
            subscription_id("https://a/2")
        );
    }
}
