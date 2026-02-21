use super::{router, state::AppState, webrtc::build_webrtc_api};
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

    let client = Client::with_uri_str(&mongodb_uri)
        .await
        .expect("Failed to connect to MongoDB");
    let db = client.database("chatter");

    // Create indexes
    create_indexes(&db).await;

    // Load room_members cache from MongoDB
    let room_members = load_room_members_cache(&db).await;

    let webrtc_api = build_webrtc_api();

    Arc::new(AppState {
        db,
        jwt_secret,
        room_members: RwLock::new(room_members),
        active_websockets: RwLock::new(HashMap::new()),
        voice_channels: RwLock::new(HashMap::new()),
        user_presence: RwLock::new(HashMap::new()),
        webrtc_api,
        screen_publishers: RwLock::new(HashMap::new()),
        screen_subscribers: RwLock::new(HashMap::new()),
        voice_publishers: RwLock::new(HashMap::new()),
        voice_subscribers: RwLock::new(HashMap::new()),
        link_previews: RwLock::new(HashMap::new()),
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
}

async fn load_room_members_cache(db: &mongodb::Database) -> HashMap<String, Vec<String>> {
    use futures_util::TryStreamExt;
    use mongodb::bson::doc;

    let mut cache: HashMap<String, Vec<String>> = HashMap::new();

    let collection = db.collection::<super::state::RoomMemberRecord>("room_members");
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

pub async fn run() {
    let state = build_state().await;
    let app = build_app(state);

    println!("Chatter server running on http://0.0.0.0:8000");
    let listener = tokio::net::TcpListener::bind("0.0.0.0:8000").await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
