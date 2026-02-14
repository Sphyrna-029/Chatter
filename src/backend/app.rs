use super::{router, state::AppState, webrtc::build_webrtc_api};
use axum::Router;
use std::{collections::HashMap, sync::Arc};
use tokio::sync::RwLock;

pub fn build_app(state: Arc<AppState>) -> Router {
    router::build_router().with_state(state)
}

pub fn build_state() -> Arc<AppState> {
    let webrtc_api = build_webrtc_api();

    Arc::new(AppState {
        users: RwLock::new(HashMap::new()),
        rooms: RwLock::new(HashMap::new()),
        room_members: RwLock::new(HashMap::new()),
        messages: RwLock::new(HashMap::new()),
        message_reactions: RwLock::new(HashMap::new()),
        access_tokens: RwLock::new(HashMap::new()),
        active_websockets: RwLock::new(HashMap::new()),
        voice_channels: RwLock::new(HashMap::new()),
        user_presence: RwLock::new(HashMap::new()),
        webrtc_api,
        screen_publishers: RwLock::new(HashMap::new()),
        screen_subscribers: RwLock::new(HashMap::new()),
        voice_publishers: RwLock::new(HashMap::new()),
        voice_subscribers: RwLock::new(HashMap::new()),
        dm_rooms: RwLock::new(HashMap::new()),
        link_previews: RwLock::new(HashMap::new()),
    })
}

pub async fn run() {
    let state = build_state();
    let app = build_app(state);

    println!("Chatter server running on http://0.0.0.0:8000");
    let listener = tokio::net::TcpListener::bind("0.0.0.0:8000").await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
