use axum::extract::ws::Message;
use mongodb::Database;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicU64, AtomicU8},
        Arc, Mutex,
    },
};
use tokio::{
    sync::{broadcast, mpsc, RwLock},
    task::JoinHandle,
};
use webrtc::{
    api::API, peer_connection::RTCPeerConnection,
    rtp_transceiver::rtp_codec::RTCRtpCodecCapability,
    track::track_local::track_local_static_rtp::TrackLocalStaticRTP,
};

pub(crate) type WsSender = mpsc::UnboundedSender<Message>;

/// Holds registration data in memory until TOTP is verified.
#[derive(Clone)]
pub(crate) struct PendingRegistration {
    pub(crate) password_hash: String,
    pub(crate) totp_secret: String,
    pub(crate) is_admin: bool,
    pub(crate) created_at: f64,
}

pub(crate) struct ServerSettings {
    pub(crate) invite_only: bool,
    pub(crate) invite_code: String,
    pub(crate) storage_limit_bytes: u64, // 0 = unlimited
    pub(crate) upload_limit_bytes: u64,  // max single file size; 0 = unlimited
    pub(crate) room_creation_limit: u64, // 0 = unlimited
    pub(crate) require_auth_for_uploads: bool,
    pub(crate) room_creation_disabled: bool,
}

pub struct AppState {
    // MongoDB
    pub(crate) db: Database,
    pub(crate) jwt_secret: String,

    // Server settings cache
    pub(crate) server_settings: RwLock<ServerSettings>,

    // Write-through cache for room members (avoids DB query on every broadcast)
    pub(crate) room_members: RwLock<HashMap<String, Vec<String>>>,
    // Cache: room_id -> user_id -> role ("owner", "moderator", "member")
    pub(crate) room_roles: RwLock<HashMap<String, HashMap<String, String>>>,
    // Cache: room_id -> list of banned user_ids
    pub(crate) banned_users: RwLock<HashMap<String, Vec<String>>>,

    // Ephemeral in-memory state (not persisted)
    // Maps user_id -> { conn_id -> sender } so multiple devices can be connected simultaneously.
    pub(crate) active_websockets: RwLock<HashMap<String, HashMap<u64, WsSender>>>,
    /// Which of a user's connections authenticated from a phone.
    ///
    /// Kept per connection rather than as one flag on the presence record: a
    /// phone and a desktop can be connected at once, and the phone leaving has
    /// to revise the answer while the desktop keeps the session — and the
    /// record — alive. A single flag could only ever record whichever device
    /// connected last, and nothing revised it until every device had gone.
    pub(crate) mobile_connections: RwLock<HashMap<String, HashSet<u64>>>,
    pub(crate) voice_channels: RwLock<HashMap<String, HashMap<String, VoiceMemberState>>>,
    // Server-muted users per room. Held outside VoiceMemberState so a moderator's
    // mute survives the user leaving and rejoining the channel.
    pub(crate) voice_force_muted: RwLock<HashMap<String, Vec<String>>>,
    // Timestamp (ms since epoch) when each voice channel went from empty to occupied
    pub(crate) voice_channel_occupied_since: RwLock<HashMap<String, u64>>,
    // Last speaking set broadcast per voice channel, so the periodic sweep only
    // sends an update when it actually changes.
    pub(crate) voice_speaking: RwLock<HashMap<String, Vec<String>>>,
    pub(crate) user_presence: RwLock<HashMap<String, PresenceRecord>>,
    pub(crate) webrtc_api: Arc<API>,
    pub(crate) screen_publishers: RwLock<HashMap<String, ScreenPublisherState>>,
    pub(crate) screen_subscribers: RwLock<HashMap<String, ScreenSubscriberState>>,
    pub(crate) webcam_publishers: RwLock<HashMap<String, WebcamPublisherState>>,
    pub(crate) webcam_subscribers: RwLock<HashMap<String, WebcamSubscriberState>>,
    pub(crate) voice_publishers: RwLock<HashMap<String, VoicePublisherState>>,
    // One entry per listener, keyed by their user id.
    pub(crate) voice_listeners: RwLock<HashMap<String, VoiceListenerState>>,
    pub(crate) link_previews: RwLock<HashMap<String, CachedPreview>>,
    pub(crate) totp_attempts: RwLock<HashMap<String, TotpAttemptRecord>>,
    // Token buckets for rate limiting and slowmode, keyed by "<bucket>:<who>".
    // Ephemeral on purpose: a restart forgiving everyone's limit is a better
    // trade than persisting a write per action.
    pub(crate) rate_limits: RwLock<HashMap<String, super::ratelimit::Bucket>>,
    pub(crate) pending_registrations: RwLock<HashMap<String, PendingRegistration>>,
    pub(crate) watch_party_rooms: RwLock<HashMap<String, WatchPartyState>>,
    pub(crate) klipy_api_key: String,
    pub(crate) steam_api_key: String,
    pub(crate) spotify_client_id: String,
    pub(crate) spotify_client_secret: String,
    // Cache: user_id -> (access_token, expires_at_unix_secs)
    pub(crate) spotify_tokens: RwLock<HashMap<String, (String, f64)>>,
    // One-time login codes for Steam OAuth — nonce -> payload, expires in 60s
    pub(crate) steam_login_codes: RwLock<HashMap<String, SteamLoginCode>>,
    // Web Push application-server keypair. None when push is misconfigured, in
    // which case delivery is skipped rather than attempted and failed.
    pub(crate) vapid: Option<super::push::VapidKeys>,
    // Shared outbound HTTP client. Push delivery reuses one connection pool
    // across every message rather than building a client per notification.
    pub(crate) http_client: reqwest::Client,
}

#[derive(Clone)]
pub(crate) struct SteamLoginCode {
    pub(crate) access_token: String,
    pub(crate) refresh_token: String,
    pub(crate) user_id: String,
    pub(crate) is_admin: bool,
    pub(crate) totp_verified: bool,
    pub(crate) expires_at: f64, // unix seconds
}

#[derive(Clone)]
pub(crate) struct TotpAttemptRecord {
    pub(crate) count: u32,
    pub(crate) window_start: f64,
}

// ─── MongoDB document types ──────────────────────────────────────────────────

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct UserRecord {
    #[serde(rename = "_id")]
    pub(crate) user_id: String,
    pub(crate) password_hash: String,
    pub(crate) avatar_url: String,
    pub(crate) about: String,
    #[serde(default)]
    pub(crate) banner_url: String,
    #[serde(default)]
    pub(crate) display_name: String,
    #[serde(default)]
    pub(crate) totp_secret: String,
    #[serde(default)]
    pub(crate) totp_verified: bool,
    #[serde(default)]
    pub(crate) recovery_codes: Vec<String>,
    #[serde(default)]
    pub(crate) custom_status: String,
    #[serde(default)]
    pub(crate) manual_status: Option<String>,
    /// A short sound played to a voice channel when this user arrives.
    /// Empty means none; length is capped when it is chosen (see sounds.rs).
    #[serde(default)]
    pub(crate) entrance_sound_url: String,
    #[serde(default)]
    pub(crate) is_admin: bool,
    #[serde(default)]
    pub(crate) disabled: bool,
    #[serde(default)]
    pub(crate) name_font_url: String,
    /// How this person's profile is painted. Separate from the app theme,
    /// which is the viewer's choice about their own client — this one travels
    /// with the person and every viewer sees it.
    #[serde(default)]
    pub(crate) profile_theme: ProfileThemeRecord,
    #[serde(default)]
    pub(crate) must_reset_password: bool,
    #[serde(default)]
    pub(crate) steam_id: Option<String>,
    #[serde(default)]
    pub(crate) hide_steam_game: bool,
    #[serde(default)]
    pub(crate) spotify_refresh_token: Option<String>,
    #[serde(default)]
    pub(crate) hide_spotify: bool,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct RoomRecord {
    #[serde(rename = "_id")]
    pub(crate) room_id: String,
    pub(crate) name: String,
    pub(crate) topic: String,
    pub(crate) creator: String,
    pub(crate) is_dm: bool,
    pub(crate) tags: Vec<String>,
    pub(crate) icon_url: String,
    pub(crate) custom_emojis: Vec<String>,
    #[serde(default)]
    pub(crate) emoji_aliases: HashMap<String, String>,
    #[serde(default)]
    pub(crate) owner_name_color: String,
    #[serde(default)]
    pub(crate) mod_name_color: String,
    #[serde(default)]
    pub(crate) unlisted: bool,
    #[serde(default)]
    pub(crate) password_hash: String,
    #[serde(default)]
    pub(crate) room_type: String,
    #[serde(default)]
    pub(crate) read_only: bool,
    #[serde(default)]
    pub(crate) banner_url: String,
    /// When true, use the stored name as-is for DMs instead of auto-generating from members.
    #[serde(default)]
    pub(crate) dm_name_override: bool,
    /// The room's sound pack: event name -> `/external/...` URL. An event with
    /// no entry falls back to the client's built-in sound, so a partial pack
    /// is normal rather than broken. Keys are limited to `sounds::PACK_EVENTS`.
    #[serde(default)]
    pub(crate) sounds: HashMap<String, String>,
    /// Whether members' entrance stings play in this room's voice channels.
    /// Defaults to on; a room that finds them tiresome turns them off for
    /// everyone rather than asking each member to.
    #[serde(default = "default_true")]
    pub(crate) entrance_sounds_enabled: bool,
    /// A theme this room offers its members, as a `ct1_` share code.
    ///
    /// A suggestion, never an imposition: the client shows it once and applies
    /// nothing on its own. Stored as the code rather than as a theme document
    /// because the client already has one decoder for these that validates
    /// every field — modelling a theme a second time on this side would be a
    /// second place for the two to disagree, and nothing here renders it.
    #[serde(default)]
    pub(crate) suggested_theme: String,
}

/// A thread, kept as its own record rather than derived from its messages.
///
/// Everything about a thread that a listing needs — when it was last active,
/// how many replies it has, who is in it — used to be recomputed on every
/// read: a `distinct()` over every message in the room, then a count per
/// thread. That cannot answer "active in the last three days" without a scan,
/// which is exactly what the channel list asks for.
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct ThreadRecord {
    /// The root message's `event_id`.
    #[serde(rename = "_id")]
    pub(crate) thread_id: String,
    pub(crate) room_id: String,
    /// Empty for rooms whose messages carry no channel (DMs).
    #[serde(default)]
    pub(crate) channel_id: String,
    #[serde(default)]
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) reply_count: i64,
    #[serde(default)]
    pub(crate) participants: Vec<String>,
    /// When the newest reply landed. The channel list's preview turns on this
    /// alone, and it is why the record exists — the root message's own
    /// timestamp says when the thread *started*, which for a listing sorted by
    /// activity is the wrong number entirely.
    pub(crate) last_activity_ts: i64,
    pub(crate) created_at: i64,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct ForumPostRecord {
    #[serde(rename = "_id")]
    pub(crate) post_id: String,
    pub(crate) room_id: String,
    pub(crate) author: String,
    pub(crate) title: String,
    pub(crate) body: String,
    /// The first of `image_urls`, still written so that anything reading a row
    /// by the old shape sees a post's lead image rather than nothing.
    #[serde(default)]
    pub(crate) image_url: String,
    /// Every image on the post. Absent on rows written when a post could only
    /// carry one, which is why `image_url` is still the fallback on read.
    #[serde(default)]
    pub(crate) image_urls: Vec<String>,
    #[serde(default)]
    pub(crate) video_urls: Vec<String>,
    pub(crate) created_at: i64,
    #[serde(default)]
    pub(crate) comment_count: i64,
    #[serde(default)]
    pub(crate) last_activity: i64,
    #[serde(default)]
    pub(crate) deleted: bool,
    #[serde(default)]
    pub(crate) edited: bool,
    #[serde(default)]
    pub(crate) edited_at: i64,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct ForumCommentRecord {
    #[serde(rename = "_id")]
    pub(crate) comment_id: String,
    pub(crate) post_id: String,
    pub(crate) room_id: String,
    pub(crate) author: String,
    pub(crate) body: String,
    /// As on a post: the first of `image_urls`, kept for older readers.
    #[serde(default)]
    pub(crate) image_url: String,
    #[serde(default)]
    pub(crate) image_urls: Vec<String>,
    #[serde(default)]
    pub(crate) video_urls: Vec<String>,
    /// The comment this one answers, or empty when it answers the post itself.
    /// Empty on every row written before replies could nest, which is exactly
    /// right: those are all top-level.
    #[serde(default)]
    pub(crate) parent_id: String,
    pub(crate) created_at: i64,
    #[serde(default)]
    pub(crate) deleted: bool,
    #[serde(default)]
    pub(crate) edited: bool,
    #[serde(default)]
    pub(crate) edited_at: i64,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct RoomMemberRecord {
    pub(crate) room_id: String,
    pub(crate) user_id: String,
    #[serde(default = "default_member_role")]
    pub(crate) role: String,
    #[serde(default)]
    pub(crate) joined_at: i64,
}

fn default_member_role() -> String {
    "member".to_string()
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct BannedUserRecord {
    pub(crate) room_id: String,
    pub(crate) user_id: String,
    pub(crate) banned_by: String,
    pub(crate) banned_at: i64,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct ReactionRecord {
    pub(crate) event_id: String,
    pub(crate) emoji: String,
    pub(crate) user_id: String,
}

/// A message pinned to a room/channel. `_id` is the pinned message's event_id,
/// so a message can only ever be pinned once.
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct PinRecord {
    #[serde(rename = "_id")]
    pub(crate) event_id: String,
    pub(crate) room_id: String,
    #[serde(default)]
    pub(crate) channel_id: String,
    pub(crate) pinned_by: String,
    pub(crate) pinned_at: i64,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct DmRoomRecord {
    #[serde(rename = "_id")]
    pub(crate) user_pair: String, // sorted "user1|user2"
    pub(crate) room_id: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct DmStreakRecord {
    #[serde(rename = "_id")]
    pub(crate) user_pair: String, // sorted "user1|user2"
    pub(crate) streak_count: u32,
    pub(crate) last_message_ts: i64, // ms since epoch of last streak-relevant message
    pub(crate) last_streak_date: String, // "YYYY-MM-DD" UTC date of last counted message
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct InviteRecord {
    #[serde(rename = "_id")]
    pub(crate) code: String,
    pub(crate) room_id: String,
    pub(crate) creator: String,
    pub(crate) click_count: u64,
    pub(crate) created_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) expires_at: Option<i64>,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct UploadRecord {
    pub(crate) user_id: String,
    pub(crate) filename: String,
    pub(crate) url: String,
    pub(crate) disk_path: String,
    pub(crate) size: u64,
    pub(crate) uploaded_at: i64,
    /// Pixel dimensions of an image, so a message can be laid out at the right
    /// height before the image itself has loaded. Optional and defaulted
    /// because every upload predating this has none, and because plenty of
    /// uploads are not images at all.
    #[serde(default)]
    pub(crate) width: Option<u32>,
    #[serde(default)]
    pub(crate) height: Option<u32>,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct RefreshTokenRecord {
    pub(crate) token: String,
    pub(crate) user_id: String,
    pub(crate) expires_at: chrono::DateTime<chrono::Utc>,
    #[serde(default)]
    pub(crate) ip_address: String,
    #[serde(default)]
    pub(crate) user_agent: String,
    #[serde(default)]
    pub(crate) created_at: i64, // ms since epoch
    #[serde(default)]
    pub(crate) session_id: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct WhiteboardStrokeRecord {
    #[serde(rename = "_id")]
    pub(crate) stroke_id: String,
    pub(crate) room_id: String,
    #[serde(default)]
    pub(crate) channel_id: String,
    pub(crate) user_id: String,
    pub(crate) tool: String,
    pub(crate) color: String,
    pub(crate) width: f64,
    pub(crate) points: Vec<Vec<f64>>,
    #[serde(default)]
    pub(crate) fill: bool,
    pub(crate) timestamp: i64,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct FriendshipRecord {
    #[serde(rename = "_id")]
    pub(crate) pair_key: String, // sorted "userA|userB"
    pub(crate) user_a: String,
    pub(crate) user_b: String,
    pub(crate) created_at: i64,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct FriendRequestRecord {
    #[serde(rename = "_id")]
    pub(crate) request_id: String,
    pub(crate) from_user: String,
    pub(crate) to_user: String,
    pub(crate) created_at: i64,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct BlockRecord {
    pub(crate) blocker: String,
    pub(crate) blocked: String,
    pub(crate) created_at: i64,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct WebhookRecord {
    #[serde(rename = "_id")]
    pub(crate) webhook_id: String,
    pub(crate) room_id: String,
    pub(crate) creator: String,
    pub(crate) name: String,
    pub(crate) avatar_url: String,
    #[serde(default)]
    pub(crate) channel_id: String,
    /// HMAC-SHA256 secret for verifying incoming payloads. Empty string = no verification (legacy).
    #[serde(default)]
    pub(crate) secret: String,
    pub(crate) created_at: i64,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct BotRecord {
    #[serde(rename = "_id")]
    pub(crate) bot_id: String,
    pub(crate) room_id: String,
    pub(crate) name: String,
    pub(crate) avatar_url: String,
    #[serde(default)]
    pub(crate) description: String,
    pub(crate) token_hash: String,
    pub(crate) created_by: String,
    pub(crate) created_at: i64,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct RoomGroupEntry {
    pub(crate) group_id: String,
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) position: i32,
    #[serde(default)]
    pub(crate) collapsed: bool,
    #[serde(default)]
    pub(crate) room_ids: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct UserRoomGroupsRecord {
    #[serde(rename = "_id")]
    pub(crate) user_id: String,
    pub(crate) groups: Vec<RoomGroupEntry>,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct ChannelCategoryRecord {
    #[serde(rename = "_id")]
    pub(crate) category_id: String,
    pub(crate) room_id: String,
    pub(crate) name: String,
    /// Overwrites inherited by the channels in this category, unless a channel
    /// opts out with `inherit_category_permissions = false`.
    #[serde(default)]
    pub(crate) overwrites: Vec<PermissionOverwrite>,
    #[serde(default)]
    pub(crate) position: i32,
    pub(crate) created_by: String,
    pub(crate) created_at: i64,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct ChannelRecord {
    #[serde(rename = "_id")]
    pub(crate) channel_id: String,
    pub(crate) room_id: String,
    pub(crate) name: String,
    pub(crate) channel_type: String, // "text" | "voice"
    #[serde(default)]
    pub(crate) topic: String,
    #[serde(default)]
    pub(crate) position: i32,
    #[serde(default)]
    pub(crate) category_id: String,
    #[serde(default)]
    pub(crate) read_only: bool,
    /// Seconds a member must wait between messages here. 0 is off. Bypassed by
    /// anyone who can manage messages, matching how read_only behaves.
    #[serde(default)]
    pub(crate) slowmode_secs: u32,
    /// Per-channel permission overwrites, applied over the room-level set and
    /// after any inherited from the channel's category.
    #[serde(default)]
    pub(crate) overwrites: Vec<PermissionOverwrite>,
    /// When true (the default) the category's overwrites apply first and this
    /// channel's refine them; set false to ignore the category entirely.
    #[serde(default = "default_true")]
    pub(crate) inherit_category_permissions: bool,
    /// Set once the legacy view_roles/write_roles have been folded into
    /// `overwrites`, so the one-time migration never runs twice.
    #[serde(default)]
    pub(crate) overwrites_migrated: bool,
    #[serde(default)]
    pub(crate) view_roles: Vec<String>, // legacy; superseded by `overwrites`
    #[serde(default)]
    pub(crate) write_roles: Vec<String>, // legacy; superseded by `overwrites`
    #[serde(default)]
    pub(crate) showcase_write_roles: Vec<String>, // role_ids that can post in the featured (left) pane of showcase channels
    #[serde(default)]
    pub(crate) showcase_posters: Vec<String>, // user_ids explicitly approved to post in the featured pane
    #[serde(default)]
    pub(crate) system_channel: bool, // if true, join/leave/kick/ban messages go here
    #[serde(default)]
    pub(crate) bot_id: String, // non-empty only for channel_type == "bot"
    #[serde(default = "default_voice_bitrate")]
    pub(crate) voice_bitrate: i32, // Opus target bitrate in bps, voice channels only
    pub(crate) created_by: String,
    pub(crate) created_at: i64,
}

fn default_voice_bitrate() -> i32 {
    super::constants::VOICE_BITRATE_DEFAULT
}

fn default_profile_fade() -> i32 {
    super::constants::PROFILE_FADE_DEFAULT
}

fn default_profile_fade_direction() -> String {
    super::constants::PROFILE_FADE_DIRECTION_DEFAULT.to_string()
}

/// One painted surface of a profile.
///
/// `color` empty means the surface is left alone. `color2` empty means the
/// colour gives out into nothing rather than turning into a second one, which
/// is a different look from a two-colour gradient and worth keeping: it lets
/// the wash blend into whatever the card is sitting on.
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct ProfileSurfaceTheme {
    #[serde(default)]
    pub(crate) color: String,
    #[serde(default)]
    pub(crate) color2: String,
    /// How far the first colour travels before it starts turning into the
    /// second: 0 is a flat wash, 100 spreads the change over the whole
    /// surface.
    #[serde(default = "default_profile_fade")]
    pub(crate) fade: i32,
    /// Which way that fade runs — `down`, `up`, `left` or `right`.
    #[serde(default = "default_profile_fade_direction")]
    pub(crate) direction: String,
}

impl Default for ProfileSurfaceTheme {
    fn default() -> Self {
        Self {
            color: String::new(),
            color2: String::new(),
            fade: super::constants::PROFILE_FADE_DEFAULT,
            direction: super::constants::PROFILE_FADE_DIRECTION_DEFAULT.to_string(),
        }
    }
}

/// The two surfaces a profile theme reaches, each set on its own: the modal
/// is a card with room for a gradient, the member-list tab is a strip beside
/// dozens of others, and what looks right on one rarely looks right on both.
#[derive(Clone, Serialize, Deserialize, Default)]
pub(crate) struct ProfileThemeRecord {
    #[serde(default)]
    pub(crate) modal: ProfileSurfaceTheme,
    #[serde(default)]
    pub(crate) tab: ProfileSurfaceTheme,
}

// ─── Custom Roles ────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Serialize, Deserialize, Debug)]
pub(crate) struct RolePermissions {
    // Baseline abilities every member has unless a role narrows them. These
    // default to true so roles stored before they existed keep working.
    #[serde(default = "default_true")]
    pub(crate) view_channel: bool,
    #[serde(default = "default_true")]
    pub(crate) send_messages: bool,
    #[serde(default = "default_true")]
    pub(crate) attach_files: bool,
    #[serde(default = "default_true")]
    pub(crate) embed_links: bool,
    #[serde(default = "default_true")]
    pub(crate) add_reactions: bool,
    /// Join a voice channel.
    #[serde(default = "default_true")]
    pub(crate) connect: bool,
    /// Transmit audio once connected. Separate from `connect` so a role can
    /// listen without talking.
    #[serde(default = "default_true")]
    pub(crate) speak: bool,

    // Elevated abilities, off unless granted.
    #[serde(default)]
    pub(crate) manage_channels: bool,
    #[serde(default)]
    pub(crate) manage_roles: bool,
    #[serde(default)]
    pub(crate) manage_messages: bool,
    #[serde(default)]
    pub(crate) manage_webhooks: bool,
    #[serde(default)]
    pub(crate) manage_emojis: bool,
    #[serde(default)]
    pub(crate) kick_members: bool,
    #[serde(default)]
    pub(crate) ban_members: bool,
    #[serde(default)]
    pub(crate) mention_everyone: bool,
}

impl RolePermissions {
    /// Nothing granted — what a non-member holds.
    pub(crate) fn none() -> Self {
        Self {
            view_channel: false,
            send_messages: false,
            attach_files: false,
            embed_links: false,
            add_reactions: false,
            connect: false,
            speak: false,
            ..Self::default()
        }
    }

    /// Everything granted — what an owner holds.
    pub(crate) fn all() -> Self {
        Self {
            view_channel: true,
            send_messages: true,
            attach_files: true,
            embed_links: true,
            add_reactions: true,
            connect: true,
            speak: true,
            manage_channels: true,
            manage_roles: true,
            manage_messages: true,
            manage_webhooks: true,
            manage_emojis: true,
            kick_members: true,
            ban_members: true,
            mention_everyone: true,
        }
    }

    /// The fixed set a built-in moderator keeps, regardless of custom roles.
    pub(crate) fn moderator() -> Self {
        Self {
            manage_channels: true,
            manage_messages: true,
            manage_webhooks: true,
            manage_emojis: true,
            kick_members: true,
            ban_members: true,
            mention_everyone: true,
            ..Self::default()
        }
    }

    /// Every permission name, in the order the UI presents them. A channel
    /// overwrite addresses permissions by these names.
    pub(crate) const NAMES: [&'static str; 15] = [
        "view_channel",
        "send_messages",
        "attach_files",
        "embed_links",
        "add_reactions",
        "connect",
        "speak",
        "manage_channels",
        "manage_roles",
        "manage_messages",
        "manage_webhooks",
        "manage_emojis",
        "kick_members",
        "ban_members",
        "mention_everyone",
    ];

    pub(crate) fn get(&self, name: &str) -> bool {
        match name {
            "view_channel" => self.view_channel,
            "send_messages" => self.send_messages,
            "attach_files" => self.attach_files,
            "embed_links" => self.embed_links,
            "add_reactions" => self.add_reactions,
            "connect" => self.connect,
            "speak" => self.speak,
            "manage_channels" => self.manage_channels,
            "manage_roles" => self.manage_roles,
            "manage_messages" => self.manage_messages,
            "manage_webhooks" => self.manage_webhooks,
            "manage_emojis" => self.manage_emojis,
            "kick_members" => self.kick_members,
            "ban_members" => self.ban_members,
            "mention_everyone" => self.mention_everyone,
            _ => false,
        }
    }

    pub(crate) fn set(&mut self, name: &str, value: bool) {
        match name {
            "view_channel" => self.view_channel = value,
            "send_messages" => self.send_messages = value,
            "attach_files" => self.attach_files = value,
            "embed_links" => self.embed_links = value,
            "add_reactions" => self.add_reactions = value,
            "connect" => self.connect = value,
            "speak" => self.speak = value,
            "manage_channels" => self.manage_channels = value,
            "manage_roles" => self.manage_roles = value,
            "manage_messages" => self.manage_messages = value,
            "manage_webhooks" => self.manage_webhooks = value,
            "manage_emojis" => self.manage_emojis = value,
            "kick_members" => self.kick_members = value,
            "ban_members" => self.ban_members = value,
            "mention_everyone" => self.mention_everyone = value,
            _ => {}
        }
    }

    /// Union with another set — assigning a second role can only grant more.
    pub(crate) fn union(self, other: &Self) -> Self {
        Self {
            view_channel: self.view_channel || other.view_channel,
            send_messages: self.send_messages || other.send_messages,
            attach_files: self.attach_files || other.attach_files,
            embed_links: self.embed_links || other.embed_links,
            add_reactions: self.add_reactions || other.add_reactions,
            connect: self.connect || other.connect,
            speak: self.speak || other.speak,
            manage_channels: self.manage_channels || other.manage_channels,
            manage_roles: self.manage_roles || other.manage_roles,
            manage_messages: self.manage_messages || other.manage_messages,
            manage_webhooks: self.manage_webhooks || other.manage_webhooks,
            manage_emojis: self.manage_emojis || other.manage_emojis,
            kick_members: self.kick_members || other.kick_members,
            ban_members: self.ban_members || other.ban_members,
            mention_everyone: self.mention_everyone || other.mention_everyone,
        }
    }
}

fn default_true() -> bool {
    true
}

impl Default for RolePermissions {
    fn default() -> Self {
        Self {
            view_channel: true,
            send_messages: true,
            attach_files: true,
            embed_links: true,
            add_reactions: true,
            connect: true,
            speak: true,
            manage_channels: false,
            manage_roles: false,
            manage_messages: false,
            manage_webhooks: false,
            manage_emojis: false,
            kick_members: false,
            ban_members: false,
            mention_everyone: false,
        }
    }
}

/// A per-channel adjustment to the room-level permissions, in Discord's shape:
/// a target (everyone / one role / one member) and the permission names it
/// explicitly allows or denies. Anything not named is left untouched, which is
/// what makes overwrites composable.
#[derive(Clone, Serialize, Deserialize, Debug, Default)]
pub(crate) struct PermissionOverwrite {
    /// "everyone" | "role" | "user"
    pub(crate) target_type: String,
    /// Role id or user id; ignored for "everyone".
    #[serde(default)]
    pub(crate) target_id: String,
    #[serde(default)]
    pub(crate) allow: Vec<String>,
    #[serde(default)]
    pub(crate) deny: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct CustomRoleRecord {
    #[serde(rename = "_id")]
    pub(crate) role_id: String,
    pub(crate) room_id: String,
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) color: String,
    #[serde(default)]
    pub(crate) position: i32,
    #[serde(default)]
    pub(crate) permissions: RolePermissions,
    pub(crate) created_by: String,
    pub(crate) created_at: i64,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct MemberCustomRoleRecord {
    pub(crate) room_id: String,
    pub(crate) user_id: String,
    pub(crate) role_id: String,
}

// ─── Ephemeral types (not persisted) ─────────────────────────────────────────

#[derive(Clone, Default)]
pub(crate) struct WatchPartyState {
    pub(crate) channel_id: String,
    pub(crate) video_url: String,
    pub(crate) playing: bool,
    pub(crate) position_secs: f64,
    pub(crate) position_updated_at: f64,
    pub(crate) duration_secs: f64,
    /// Distinct user_ids currently receiving/playing the watch-party video.
    pub(crate) viewers: Vec<String>,
}

#[derive(Clone)]
pub(crate) struct VoiceMemberState {
    pub(crate) muted: bool,
    pub(crate) deafened: bool,
    pub(crate) screen_sharing: bool,
    /// Muted by a moderator. Unlike `muted` the user cannot clear it, and the
    /// publish path refuses their audio while it is set, so a patched client
    /// cannot talk around it.
    pub(crate) force_muted: bool,
    /// Holding a rolling buffer of a screen share, ready to save the last few
    /// seconds. Broadcast so nobody's screen is being recorded unannounced.
    pub(crate) clipping: bool,
    /// The room this channel belongs to. `voice_channels` is keyed by channel
    /// id, so a disconnect has no other way back to the room whose members need
    /// telling — and broadcasting to a channel id reaches nobody at all.
    pub(crate) room_id: String,
    /// Which of the user's websocket connections holds this voice session.
    ///
    /// A user can have several connections open — a desktop and a phone — but
    /// only one of them is in the call. Without this, closing any spare tab
    /// evicted the call running on another device, and a `voice_leave` from
    /// one device ended another's.
    pub(crate) conn_id: u64,
    /// Where this person is standing, in a spatial voice channel: both axes
    /// normalized to 0..1 so the room has no pixel size anyone has to agree
    /// on. Meaningless in an ordinary voice channel, and carried by every
    /// member for the same reason the flags above are — the position belongs
    /// to the membership, so every path that ends a membership already
    /// forgets it, and every event that carries `voice_states` already
    /// carries this.
    pub(crate) x: f64,
    pub(crate) y: f64,
}

#[derive(Clone)]
pub(crate) struct PresenceRecord {
    pub(crate) last_active: f64,
    pub(crate) last_typing: f64,
    pub(crate) connected: bool,
    pub(crate) custom_status: String,
    pub(crate) manual_status: Option<String>,
    pub(crate) is_mobile: bool,
    pub(crate) steam_game: Option<String>,
    pub(crate) steam_appid: Option<String>,
    pub(crate) game_session_start: Option<f64>,
    pub(crate) spotify_track: Option<String>,
    pub(crate) spotify_artist: Option<String>,
    pub(crate) spotify_album_art: Option<String>,
}

#[derive(Clone, Serialize)]
pub(crate) struct CachedPreview {
    pub(crate) title: Option<String>,
    pub(crate) description: Option<String>,
    pub(crate) image: Option<String>,
    pub(crate) site_name: Option<String>,
}

#[derive(Clone)]
#[allow(dead_code)]
pub(crate) struct ScreenPublisherState {
    pub(crate) room_id: String,
    pub(crate) channel_id: String,
    pub(crate) peer_connection: Arc<RTCPeerConnection>,
    pub(crate) media_ssrc: Option<u32>,
    pub(crate) video_codec: Option<RTCRtpCodecCapability>,
    pub(crate) rtp_sender: Option<broadcast::Sender<rtp::packet::Packet>>,
    pub(crate) audio_ssrc: Option<u32>,
    pub(crate) audio_codec: Option<RTCRtpCodecCapability>,
    pub(crate) audio_rtp_sender: Option<broadcast::Sender<rtp::packet::Packet>>,
}

pub(crate) struct ScreenSubscriberState {
    pub(crate) viewer_user_id: String,
    pub(crate) sharer_user_id: String,
    pub(crate) peer_connection: Arc<RTCPeerConnection>,
    pub(crate) forward_task: JoinHandle<()>,
    pub(crate) audio_forward_task: Option<JoinHandle<()>>,
}

#[derive(Clone)]
#[allow(dead_code)]
pub(crate) struct WebcamPublisherState {
    pub(crate) room_id: String,
    pub(crate) channel_id: String,
    pub(crate) peer_connection: Arc<RTCPeerConnection>,
    pub(crate) media_ssrc: Option<u32>,
    pub(crate) video_codec: Option<RTCRtpCodecCapability>,
    pub(crate) rtp_sender: Option<broadcast::Sender<rtp::packet::Packet>>,
}

pub(crate) struct WebcamSubscriberState {
    pub(crate) viewer_user_id: String,
    pub(crate) sharer_user_id: String,
    pub(crate) peer_connection: Arc<RTCPeerConnection>,
    pub(crate) forward_task: JoinHandle<()>,
}

#[derive(Clone)]
#[allow(dead_code)]
pub(crate) struct VoicePublisherState {
    pub(crate) room_id: String,
    pub(crate) channel_id: String,
    pub(crate) peer_connection: Arc<RTCPeerConnection>,
    pub(crate) audio_codec: Option<RTCRtpCodecCapability>,
    pub(crate) rtp_sender: Option<broadcast::Sender<rtp::packet::Packet>>,
    /// Most recent RTP audio level, in -dBov: 0 is loudest, 127 is silence.
    /// Read straight off the header extension the browser already sends, so
    /// ranking speakers costs no decoding.
    pub(crate) audio_level: Arc<AtomicU8>,
    /// Epoch millis of the last packet loud enough to count as speech. Drives
    /// the hold window that keeps a slot with someone through a short pause.
    pub(crate) last_voice_ms: Arc<AtomicU64>,
}

/// One listener's single subscription to the call.
///
/// Audio from whoever is currently loudest is written into a fixed set of
/// slots, so the server holds one connection per participant rather than one
/// per pair of them, and sends each listener a bounded number of streams
/// however many people are in the room.
pub(crate) struct VoiceListenerState {
    pub(crate) room_id: String,
    pub(crate) channel_id: String,
    pub(crate) peer_connection: Arc<RTCPeerConnection>,
    pub(crate) slots: Vec<Arc<VoiceSlot>>,
    /// The mapping this listener was last told about.
    ///
    /// Compared against rather than the live slot state, because a slot can be
    /// vacated outside the sweep — when a speaker disconnects, say. Diffing
    /// against the slots themselves would then find nothing to do and leave the
    /// client believing someone still occupies a slot they have left.
    pub(crate) last_sent_map: Mutex<Vec<Option<String>>>,
}

pub(crate) struct VoiceSlot {
    pub(crate) track: Arc<TrackLocalStaticRTP>,
    pub(crate) assignment: Mutex<Option<VoiceSlotAssignment>>,
    /// Outgoing numbering, kept across speakers. See `restamp`.
    pub(crate) restamp: Mutex<SlotRestamp>,
}

pub(crate) struct VoiceSlotAssignment {
    pub(crate) speaker_user_id: String,
    pub(crate) forward_task: JoinHandle<()>,
}

/// A slot keeps one SSRC for the life of the connection while the speaker
/// feeding it changes. The receiver's jitter buffer tracks a stream by SSRC,
/// so the sequence numbers and timestamps it sees have to stay continuous
/// across a handover that the input knows nothing about.
#[derive(Default)]
pub(crate) struct SlotRestamp {
    pub(crate) out_seq: u16,
    pub(crate) out_ts: u32,
    pub(crate) prev_in: Option<(u16, u32)>,
}
