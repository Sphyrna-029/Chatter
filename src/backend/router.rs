use super::{
    constants::MAX_UPLOAD_SIZE,
    routes::{
        auth::{login, logout, register},
        media::{link_preview, upload_file},
        messages::{get_room_messages, redact_message, send_message},
        presence::{get_room_presence, get_voice_channel_status},
        reactions::{add_reaction, get_reactions},
        rooms::{
            create_room, join_room, joined_rooms, leave_room, list_all_rooms, update_room_topic,
        },
        static_content::{serve_client, versions},
        sync::sync,
    },
    state::AppState,
    ws::session::ws_upgrade,
};
use axum::{
    extract::DefaultBodyLimit,
    routing::{delete, get, post, put},
    Router,
};
use std::sync::Arc;
use tower_http::services::ServeDir;

pub(crate) fn build_router() -> Router<Arc<AppState>> {
    Router::new()
        // Static / client
        .route("/", get(serve_client))
        .nest_service("/assets", ServeDir::new("client/dist/assets"))
        .nest_service("/external", ServeDir::new("external"))
        // Matrix versions
        .route("/_matrix/client/versions", get(versions))
        // Auth
        .route("/_matrix/client/r0/register", post(register))
        .route("/_matrix/client/r0/login", post(login))
        .route("/_matrix/client/r0/logout", post(logout))
        // Rooms
        .route("/_matrix/client/r0/createRoom", post(create_room))
        .route("/_matrix/client/r0/rooms/{room_id}/join", post(join_room))
        .route("/_matrix/client/r0/rooms/{room_id}/leave", post(leave_room))
        .route("/_matrix/client/r0/joined_rooms", get(joined_rooms))
        .route("/api/rooms", get(list_all_rooms))
        .route(
            "/api/upload",
            post(upload_file).layer(DefaultBodyLimit::max(MAX_UPLOAD_SIZE + 2 * 1024 * 1024)),
        )
        // Messages
        .route(
            "/_matrix/client/r0/rooms/{room_id}/send/m.room.message/{txn_id}",
            put(send_message),
        )
        .route(
            "/_matrix/client/r0/rooms/{room_id}/messages",
            get(get_room_messages),
        )
        .route(
            "/_matrix/client/r0/rooms/{room_id}/redact/{event_id}/{txn_id}",
            delete(redact_message),
        )
        // Room topic
        .route(
            "/_matrix/client/r0/rooms/{room_id}/state/m.room.topic",
            put(update_room_topic),
        )
        // Sync
        .route("/_matrix/client/r0/sync", get(sync))
        // Reactions
        .route(
            "/_matrix/client/r0/rooms/{room_id}/send/m.reaction/{event_id}",
            put(add_reaction),
        )
        .route(
            "/_matrix/client/r0/rooms/{room_id}/event/{event_id}/reactions",
            get(get_reactions),
        )
        // Voice & Presence
        .route("/api/rooms/{room_id}/voice", get(get_voice_channel_status))
        .route("/api/rooms/{room_id}/presence", get(get_room_presence))
        .route("/api/link-preview", get(link_preview))
        // WebSocket
        .route("/ws", get(ws_upgrade))
}
