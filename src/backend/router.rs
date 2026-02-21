use super::{
    constants::MAX_UPLOAD_SIZE,
    routes::{
        auth::{login, logout, refresh, register},
        invites::{accept_invite, create_invite, delete_invite, get_invite_info, list_invites},
        media::{delete_upload, link_preview, list_uploads, serve_upload, upload_file},
        messages::{edit_message, get_room_messages, redact_message, send_message},
        presence::{get_room_presence, get_voice_channel_status},
        reactions::{add_reaction, get_reactions},
        rooms::{
            create_room, delete_room, join_room, joined_rooms, leave_room, list_all_rooms,
            update_room_settings, update_room_topic,
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
    // Create a nested router for /external to avoid route conflicts
       let external_router = Router::new()
           .route("/{folder}/{filename}", get(serve_upload))
           .fallback_service(ServeDir::new("external"));

       Router::new()
           // Static / client
           .route("/", get(serve_client))
           .nest_service("/assets", ServeDir::new("client/dist/assets"))
           .nest("/external", external_router)  // Use nest with the new router
           // Matrix versions
           .route("/_matrix/client/versions", get(versions))
           // Auth
           .route("/_matrix/client/r0/register", post(register))
           .route("/_matrix/client/r0/login", post(login))
           .route("/_matrix/client/r0/logout", post(logout))
           .route("/_matrix/client/r0/refresh", post(refresh))
           // Rooms
           .route("/_matrix/client/r0/createRoom", post(create_room))
           .route("/_matrix/client/r0/rooms/{room_id}/join", post(join_room))
           .route("/_matrix/client/r0/rooms/{room_id}/leave", post(leave_room))
           .route("/_matrix/client/r0/joined_rooms", get(joined_rooms))
           .route("/api/rooms", get(list_all_rooms))
           .route("/api/rooms/{room_id}", delete(delete_room))
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
           .route(
               "/_matrix/client/r0/rooms/{room_id}/edit/{event_id}/{txn_id}",
               put(edit_message),
           )
           // Room topic
           .route(
               "/_matrix/client/r0/rooms/{room_id}/state/m.room.topic",
               put(update_room_topic),
           )
           // Room settings (name, icon, tags)
           .route(
               "/_matrix/client/r0/rooms/{room_id}/state/m.room.settings",
               put(update_room_settings),
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
           .route("/api/uploads", get(list_uploads).delete(delete_upload))
           // Invites
           .route("/api/rooms/{room_id}/invites", post(create_invite))
           .route("/api/rooms/{room_id}/invites", get(list_invites))
           .route("/api/invites/{code}", delete(delete_invite))
           .route("/api/invites/{code}", get(get_invite_info))
           .route("/api/invites/{code}/accept", post(accept_invite))
           // SPA fallback for invite pages
           .route("/invite/{code}", get(serve_client))
           // WebSocket
           .route("/ws", get(ws_upgrade))
   }
