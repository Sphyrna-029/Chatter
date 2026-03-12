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

pub(crate) struct ServerSettings {
    pub(crate) invite_only: bool,
    pub(crate) invite_code: String,
    pub(crate) storage_limit_bytes: u64, // 0 = unlimited
    pub(crate) room_creation_limit: u64, // 0 = unlimited
    pub(crate) require_auth_for_uploads: bool,
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
    pub(crate) active_websockets: RwLock<HashMap<String, WsSender>>,
    pub(crate) voice_channels: RwLock<HashMap<String, HashMap<String, VoiceMemberState>>>,
    pub(crate) user_presence: RwLock<HashMap<String, PresenceRecord>>,
    pub(crate) webrtc_api: Arc<API>,
    pub(crate) screen_publishers: RwLock<HashMap<String, ScreenPublisherState>>,
    pub(crate) screen_subscribers: RwLock<HashMap<String, ScreenSubscriberState>>,
    pub(crate) voice_publishers: RwLock<HashMap<String, VoicePublisherState>>,
    pub(crate) voice_subscribers: RwLock<HashMap<String, VoiceSubscriberState>>,
    pub(crate) link_previews: RwLock<HashMap<String, CachedPreview>>,
    pub(crate) totp_attempts: RwLock<HashMap<String, TotpAttemptRecord>>,
    pub(crate) tank_games: RwLock<HashMap<String, tokio::task::JoinHandle<()>>>,
    pub(crate) watch_party_rooms: RwLock<HashMap<String, WatchPartyState>>,
    pub(crate) tug_of_war_games: RwLock<HashMap<String, tokio::task::JoinHandle<()>>>,
    pub(crate) klipy_api_key: String,
    pub(crate) steam_api_key: String,
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
pub(crate) struct InviteRecord {
    #[serde(rename = "_id")]
    pub(crate) code: String,
    pub(crate) room_id: String,
    pub(crate) creator: String,
    pub(crate) click_count: u64,
    pub(crate) created_at: i64,
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
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct WhiteboardStrokeRecord {
    #[serde(rename = "_id")]
    pub(crate) stroke_id: String,
    pub(crate) room_id: String,
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

// ─── Ephemeral types (not persisted) ─────────────────────────────────────────

#[derive(Clone)]
pub(crate) struct WatchPartyState {
    pub(crate) video_url: String,
    pub(crate) playing: bool,
    pub(crate) position_secs: f64,
    pub(crate) position_updated_at: f64,
    pub(crate) host_user_id: String,
    pub(crate) duration_secs: f64,
}

#[derive(Clone)]
pub(crate) struct VoiceMemberState {
    pub(crate) muted: bool,
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
}

#[derive(Clone, Serialize)]
pub(crate) struct CachedPreview {
    pub(crate) title: Option<String>,
    pub(crate) description: Option<String>,
    pub(crate) image: Option<String>,
    pub(crate) site_name: Option<String>,
}

#[derive(Clone)]
pub(crate) struct ScreenPublisherState {
    pub(crate) room_id: String,
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
pub(crate) struct VoicePublisherState {
    pub(crate) room_id: String,
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
