use super::{router, state::{AppState, ServerSettings}, webrtc::build_webrtc_api};
use axum::Router;
use mongodb::{Client, IndexModel, options::IndexOptions};
use std::{collections::HashMap, sync::Arc};
use tokio::sync::RwLock;

pub fn build_app(state: Arc<AppState>) -> Router {
    router::build_router().with_state(state)
}

pub async fn build_state() -> Arc<AppState> {
    let _ = dotenvy::dotenv();

    let mongodb_uri =
        std::env::var("MONGODB_URI").unwrap_or_else(|_| "mongodb://localhost:27017".to_string());
    let jwt_secret =
        std::env::var("JWT_SECRET").unwrap_or_else(|_| "change-me-in-production".to_string());
    let klipy_api_key = std::env::var("KLIPY_API_KEY").unwrap_or_default();

    let client = Client::with_uri_str(&mongodb_uri)
        .await
        .expect("Failed to connect to MongoDB");
    let db = client.database("chatter");

    // Create indexes
    create_indexes(&db).await;

    // Load caches from MongoDB
    let (room_members, room_roles) = load_room_members_cache(&db).await;
    let banned_users = load_banned_users_cache(&db).await;
    let server_settings = load_server_settings(&db).await;

    let webrtc_api = build_webrtc_api();

    Arc::new(AppState {
        db,
        jwt_secret,
        server_settings: RwLock::new(server_settings),
        room_members: RwLock::new(room_members),
        room_roles: RwLock::new(room_roles),
        banned_users: RwLock::new(banned_users),
        active_websockets: RwLock::new(HashMap::new()),
        voice_channels: RwLock::new(HashMap::new()),
        user_presence: RwLock::new(HashMap::new()),
        webrtc_api,
        screen_publishers: RwLock::new(HashMap::new()),
        screen_subscribers: RwLock::new(HashMap::new()),
        voice_publishers: RwLock::new(HashMap::new()),
        voice_subscribers: RwLock::new(HashMap::new()),
        link_previews: RwLock::new(HashMap::new()),
        totp_attempts: RwLock::new(HashMap::new()),
        tank_games: RwLock::new(HashMap::new()),
        klipy_api_key,
    })
}

async fn create_indexes(db: &mongodb::Database) {
    use mongodb::bson::doc;

    // room_members: unique compound {room_id, user_id}
    let _ = db
        .collection::<mongodb::bson::Document>("room_members")
        .create_index(
            IndexModel::builder()
                .keys(doc! { "room_id": 1, "user_id": 1 })
                .options(IndexOptions::builder().unique(true).build())
                .build(),
        )
        .await;

    // messages: compound {room_id, origin_server_ts}
    let _ = db
        .collection::<mongodb::bson::Document>("messages")
        .create_index(
            IndexModel::builder()
                .keys(doc! { "room_id": 1, "origin_server_ts": -1 })
                .build(),
        )
        .await;

    // reactions: unique compound {event_id, emoji, user_id}
    let _ = db
        .collection::<mongodb::bson::Document>("reactions")
        .create_index(
            IndexModel::builder()
                .keys(doc! { "event_id": 1, "emoji": 1, "user_id": 1 })
                .options(IndexOptions::builder().unique(true).build())
                .build(),
        )
        .await;

    // uploads: index on user_id
    let _ = db
        .collection::<mongodb::bson::Document>("uploads")
        .create_index(
            IndexModel::builder()
                .keys(doc! { "user_id": 1 })
                .build(),
        )
        .await;

    // refresh_tokens: unique on token
    let _ = db
        .collection::<mongodb::bson::Document>("refresh_tokens")
        .create_index(
            IndexModel::builder()
                .keys(doc! { "token": 1 })
                .options(IndexOptions::builder().unique(true).build())
                .build(),
        )
        .await;

    // refresh_tokens: TTL on expires_at
    let _ = db
        .collection::<mongodb::bson::Document>("refresh_tokens")
        .create_index(
            IndexModel::builder()
                .keys(doc! { "expires_at": 1 })
                .options(
                    IndexOptions::builder()
                        .expire_after(std::time::Duration::from_secs(0))
                        .build(),
                )
                .build(),
        )
        .await;

    // invites: index on room_id
    let _ = db
        .collection::<mongodb::bson::Document>("invites")
        .create_index(
            IndexModel::builder()
                .keys(doc! { "room_id": 1 })
                .build(),
        )
        .await;

    // friend_requests: unique compound {from_user, to_user}
    let _ = db
        .collection::<mongodb::bson::Document>("friend_requests")
        .create_index(
            IndexModel::builder()
                .keys(doc! { "from_user": 1, "to_user": 1 })
                .options(IndexOptions::builder().unique(true).build())
                .build(),
        )
        .await;

    // friend_requests: index on to_user (for incoming lookups)
    let _ = db
        .collection::<mongodb::bson::Document>("friend_requests")
        .create_index(
            IndexModel::builder()
                .keys(doc! { "to_user": 1 })
                .build(),
        )
        .await;

    // friendships: index on user_a
    let _ = db
        .collection::<mongodb::bson::Document>("friendships")
        .create_index(
            IndexModel::builder()
                .keys(doc! { "user_a": 1 })
                .build(),
        )
        .await;

    // friendships: index on user_b
    let _ = db
        .collection::<mongodb::bson::Document>("friendships")
        .create_index(
            IndexModel::builder()
                .keys(doc! { "user_b": 1 })
                .build(),
        )
        .await;

    // webhooks: index on room_id
    let _ = db
        .collection::<mongodb::bson::Document>("webhooks")
        .create_index(
            IndexModel::builder()
                .keys(doc! { "room_id": 1 })
                .build(),
        )
        .await;

    // blocks: unique compound {blocker, blocked}
    let _ = db
        .collection::<mongodb::bson::Document>("blocks")
        .create_index(
            IndexModel::builder()
                .keys(doc! { "blocker": 1, "blocked": 1 })
                .options(IndexOptions::builder().unique(true).build())
                .build(),
        )
        .await;
}

async fn load_room_members_cache(
    db: &mongodb::Database,
) -> (
    HashMap<String, Vec<String>>,
    HashMap<String, HashMap<String, String>>,
) {
    use futures_util::TryStreamExt;
    use mongodb::bson::doc;

    let mut members_cache: HashMap<String, Vec<String>> = HashMap::new();
    let mut roles_cache: HashMap<String, HashMap<String, String>> = HashMap::new();

    let collection = db.collection::<super::state::RoomMemberRecord>("room_members");
    if let Ok(mut cursor) = collection.find(doc! {}).await {
        while let Ok(Some(record)) = cursor.try_next().await {
            members_cache
                .entry(record.room_id.clone())
                .or_default()
                .push(record.user_id.clone());
            roles_cache
                .entry(record.room_id)
                .or_default()
                .insert(record.user_id, record.role);
        }
    }

    (members_cache, roles_cache)
}

async fn load_banned_users_cache(db: &mongodb::Database) -> HashMap<String, Vec<String>> {
    use futures_util::TryStreamExt;
    use mongodb::bson::doc;

    let mut cache: HashMap<String, Vec<String>> = HashMap::new();

    let collection = db.collection::<super::state::BannedUserRecord>("banned_users");
    if let Ok(mut cursor) = collection.find(doc! {}).await {
        while let Ok(Some(record)) = cursor.try_next().await {
            cache
                .entry(record.room_id)
                .or_default()
                .push(record.user_id);
        }
    }

    cache
}

async fn load_server_settings(db: &mongodb::Database) -> ServerSettings {
    use mongodb::bson::doc;

    let coll = db.collection::<mongodb::bson::Document>("server_settings");
    if let Ok(Some(doc)) = coll.find_one(doc! { "_id": "global" }).await {
        let invite_only = doc.get_bool("invite_only").unwrap_or(false);
        let invite_code = doc.get_str("invite_code").unwrap_or("").to_string();
        let storage_limit_bytes = doc.get_i64("storage_limit_bytes").unwrap_or(0) as u64;
        let room_creation_limit = doc.get_i64("room_creation_limit").unwrap_or(0) as u64;
        return ServerSettings { invite_only, invite_code, storage_limit_bytes, room_creation_limit };
    }

    // Create default settings
    let code = generate_invite_code();
    let default_doc = doc! {
        "_id": "global",
        "invite_only": false,
        "invite_code": &code,
        "storage_limit_bytes": 0_i64,
        "room_creation_limit": 0_i64,
    };
    let _ = coll.insert_one(default_doc).await;
    ServerSettings { invite_only: false, invite_code: code, storage_limit_bytes: 0, room_creation_limit: 0 }
}

pub(crate) fn generate_invite_code() -> String {
    use rand::Rng;
    let chars: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let mut rng = rand::thread_rng();
    (0..8).map(|_| chars[rng.gen_range(0..chars.len())] as char).collect()
}

pub async fn run() {
    let state = build_state().await;
    let app = build_app(state);

    println!("Chatter server running on http://0.0.0.0:8000");
    let listener = tokio::net::TcpListener::bind("0.0.0.0:8000").await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
