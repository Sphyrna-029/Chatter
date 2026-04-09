use axum::extract::ws::Message;
use mongodb::Database;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::Arc};
use tokio::{
    sync::{broadcast, mpsc, RwLock},
    task::JoinHandle,
};
use webrtc::{
    api::API, peer_connection::RTCPeerConnection, rtp_transceiver::rtp_codec::RTCRtpCodecCapability,
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
    pub(crate) voice_channels: RwLock<HashMap<String, HashMap<String, VoiceMemberState>>>,
    // Timestamp (ms since epoch) when each voice channel went from empty to occupied
    pub(crate) voice_channel_occupied_since: RwLock<HashMap<String, u64>>,
    // Queued subscribe offers waiting for a publisher's audio track to arrive
    // Key = speaker_user_id
    pub(crate) pending_voice_subscribes: RwLock<HashMap<String, Vec<PendingVoiceSubscribe>>>,
    pub(crate) user_presence: RwLock<HashMap<String, PresenceRecord>>,
    pub(crate) webrtc_api: Arc<API>,
    pub(crate) screen_publishers: RwLock<HashMap<String, ScreenPublisherState>>,
    pub(crate) screen_subscribers: RwLock<HashMap<String, ScreenSubscriberState>>,
    pub(crate) webcam_publishers: RwLock<HashMap<String, WebcamPublisherState>>,
    pub(crate) webcam_subscribers: RwLock<HashMap<String, WebcamSubscriberState>>,
    pub(crate) voice_publishers: RwLock<HashMap<String, VoicePublisherState>>,
    pub(crate) voice_subscribers: RwLock<HashMap<String, VoiceSubscriberState>>,
    pub(crate) link_previews: RwLock<HashMap<String, CachedPreview>>,
    pub(crate) totp_attempts: RwLock<HashMap<String, TotpAttemptRecord>>,
    pub(crate) pending_registrations: RwLock<HashMap<String, PendingRegistration>>,
    pub(crate) tank_games: RwLock<HashMap<String, tokio::task::JoinHandle<()>>>,
    pub(crate) watch_party_rooms: RwLock<HashMap<String, WatchPartyState>>,
    pub(crate) tug_of_war_games: RwLock<HashMap<String, tokio::task::JoinHandle<()>>>,
    pub(crate) klipy_api_key: String,
    pub(crate) steam_api_key: String,
    pub(crate) spotify_client_id: String,
    pub(crate) spotify_client_secret: String,
    // Cache: user_id -> (access_token, expires_at_unix_secs)
    pub(crate) spotify_tokens: RwLock<HashMap<String, (String, f64)>>,
    // One-time login codes for Steam OAuth — nonce -> payload, expires in 60s
    pub(crate) steam_login_codes: RwLock<HashMap<String, SteamLoginCode>>,
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
    #[serde(default)]
    pub(crate) is_admin: bool,
    #[serde(default)]
    pub(crate) disabled: bool,
    #[serde(default)]
    pub(crate) name_font_url: String,
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
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct ForumPostRecord {
    #[serde(rename = "_id")]
    pub(crate) post_id: String,
    pub(crate) room_id: String,
    pub(crate) author: String,
    pub(crate) title: String,
    pub(crate) body: String,
    #[serde(default)]
    pub(crate) image_url: String,
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
    #[serde(default)]
    pub(crate) image_url: String,
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

fn default_game_mode() -> String {
    "ctf".to_string()
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

// ─── Tank Wars types ─────────────────────────────────────────────────────────

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct TankGameRecord {
    #[serde(rename = "_id")]
    pub(crate) game_id: String,
    pub(crate) room_id: String,
    pub(crate) status: String, // "lobby" | "running" | "finished"
    pub(crate) grid_size: usize,
    pub(crate) max_ticks: usize,
    pub(crate) current_tick: usize,
    pub(crate) maze: Vec<Vec<u8>>, // 0=empty, 1=wall
    pub(crate) players: Vec<TankPlayer>,
    pub(crate) bullets: Vec<Bullet>,
    pub(crate) flag_position: [usize; 2],
    pub(crate) winner: Option<String>,
    #[serde(default)]
    pub(crate) reset_votes: Vec<String>,
    #[serde(default = "default_game_mode")]
    pub(crate) game_mode: String, // "ctf" | "battle_royale" | "koth"
    pub(crate) created_at: i64,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct TankPlayer {
    pub(crate) user_id: String,
    pub(crate) script: String,
    pub(crate) ready: bool,
    pub(crate) x: usize,
    pub(crate) y: usize,
    pub(crate) direction: String,
    pub(crate) health: u8,
    pub(crate) alive: bool,
    pub(crate) color: String,
    pub(crate) score: u32,
    #[serde(default)]
    pub(crate) hill_ticks: u32,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Bullet {
    pub(crate) x: usize,
    pub(crate) y: usize,
    pub(crate) direction: String,
    pub(crate) owner: String,
}

// ─── Tug of War types ────────────────────────────────────────────────────────

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct TugOfWarGame {
    #[serde(rename = "_id")]
    pub(crate) game_id: String,
    pub(crate) room_id: String,
    pub(crate) status: String, // "lobby" | "running" | "finished"
    pub(crate) players: Vec<TugOfWarPlayer>,
    pub(crate) rope_position: f64, // -100.0 to 100.0; positive = right winning
    pub(crate) prompt: String,
    pub(crate) started_at: Option<i64>,
    pub(crate) winner: Option<String>, // "left" | "right" | "draw"
    #[serde(default)]
    pub(crate) reset_votes: Vec<String>,
    pub(crate) created_at: i64,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct TugOfWarPlayer {
    pub(crate) user_id: String,
    pub(crate) team: String, // "left" | "right" | "" (unassigned)
    pub(crate) ready: bool,
    pub(crate) chars_correct: u32,
    pub(crate) errors: u32,
    pub(crate) wps: f64,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct ChannelCategoryRecord {
    #[serde(rename = "_id")]
    pub(crate) category_id: String,
    pub(crate) room_id: String,
    pub(crate) name: String,
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
    #[serde(default)]
    pub(crate) view_roles: Vec<String>,   // role_ids that can see this channel (empty = everyone)
    #[serde(default)]
    pub(crate) write_roles: Vec<String>,  // role_ids that can send messages (empty = normal rules)
    #[serde(default)]
    pub(crate) showcase_write_roles: Vec<String>, // role_ids that can post in the featured (left) pane of showcase channels
    #[serde(default)]
    pub(crate) showcase_posters: Vec<String>,     // user_ids explicitly approved to post in the featured pane
    #[serde(default)]
    pub(crate) system_channel: bool,      // if true, join/leave/kick/ban messages go here
    pub(crate) created_by: String,
    pub(crate) created_at: i64,
}

// ─── Custom Roles ────────────────────────────────────────────────────────────

#[derive(Clone, Serialize, Deserialize, Debug)]
pub(crate) struct RolePermissions {
    #[serde(default = "default_true")]
    pub(crate) send_messages: bool,
    #[serde(default)]
    pub(crate) manage_channels: bool,
    #[serde(default)]
    pub(crate) manage_roles: bool,
    #[serde(default)]
    pub(crate) manage_messages: bool,
    #[serde(default)]
    pub(crate) kick_members: bool,
    #[serde(default)]
    pub(crate) ban_members: bool,
    #[serde(default)]
    pub(crate) mention_everyone: bool,
}

fn default_true() -> bool { true }

impl Default for RolePermissions {
    fn default() -> Self {
        Self {
            send_messages: true,
            manage_channels: false,
            manage_roles: false,
            manage_messages: false,
            kick_members: false,
            ban_members: false,
            mention_everyone: false,
        }
    }
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

#[derive(Clone)]
pub(crate) struct WatchPartyState {
    pub(crate) channel_id: String,
    pub(crate) video_url: String,
    pub(crate) playing: bool,
    pub(crate) position_secs: f64,
    pub(crate) position_updated_at: f64,
    pub(crate) host_user_id: String,
    pub(crate) duration_secs: f64,
}

#[derive(Clone)]
pub(crate) struct PendingVoiceSubscribe {
    pub(crate) listener_user_id: String,
    pub(crate) sdp: String,
}

#[derive(Clone)]
pub(crate) struct VoiceMemberState {
    pub(crate) muted: bool,
    pub(crate) deafened: bool,
    pub(crate) screen_sharing: bool,
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
}

pub(crate) struct VoiceSubscriberState {
    pub(crate) listener_user_id: String,
    pub(crate) speaker_user_id: String,
    pub(crate) peer_connection: Arc<RTCPeerConnection>,
    pub(crate) forward_task: JoinHandle<()>,
}
