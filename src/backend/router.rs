use super::{
    constants::MAX_UPLOAD_SIZE,
    routes::{
        admin::{admin_stats, admin_list_users, admin_disable_user, admin_enable_user, admin_delete_user, admin_reset_password, admin_list_rooms, admin_delete_room},
        auth::{change_password, check_username, delete_account, get_recovery_codes, login, logout, refresh, register, totp_setup, totp_verify},
        forum::{create_comment, create_post, delete_comment, delete_post, edit_comment, edit_post, get_post, list_posts, search_posts},
        friends::{get_friends, get_friend_status, send_friend_request, accept_friend_request, reject_friend_request, remove_friend, block_user, unblock_user},
        invites::{accept_invite, create_invite, delete_invite, get_invite_info, list_invites},
        media::{delete_upload, link_preview, list_uploads, serve_upload, upload_file},
        messages::{edit_message, get_room_messages, redact_message, search_messages, send_message},
        presence::{get_room_presence, get_voice_channel_status},
        reactions::{add_reaction, get_reactions},
        rooms::{
            ban_member, create_room, delete_room, join_room, joined_rooms, kick_member,
            leave_room, list_all_rooms, list_banned_users, set_member_role, set_name_colors,
            unban_member, update_room_settings, update_room_topic,
        },
        static_content::{serve_client, versions},
        sync::sync,
        whiteboard::get_strokes,
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
           .route("/api/check-username", post(check_username))
           .route("/api/totp/verify", post(totp_verify))
           .route("/api/totp/setup", post(totp_setup))
           .route("/api/account/password", post(change_password))
           .route("/api/account/delete", post(delete_account))
           .route("/api/recovery-codes", post(get_recovery_codes))
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
           // Permissions
           .route("/api/rooms/{room_id}/members/{user_id}", delete(kick_member))
           .route("/api/rooms/{room_id}/bans", get(list_banned_users))
           .route("/api/rooms/{room_id}/ban/{user_id}", post(ban_member))
           .route("/api/rooms/{room_id}/ban/{user_id}", delete(unban_member))
           .route("/api/rooms/{room_id}/members/{user_id}/role", put(set_member_role))
           .route("/api/rooms/{room_id}/name-colors", put(set_name_colors))
           // Search
           .route("/api/rooms/{room_id}/search", get(search_messages))
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
           // Whiteboard
           .route("/api/whiteboard/{room_id}/strokes", get(get_strokes))
           // Forum
           .route("/api/forum/{room_id}/posts", post(create_post).get(list_posts))
           .route("/api/forum/{room_id}/posts/search", get(search_posts))
           .route("/api/forum/{room_id}/posts/{post_id}", get(get_post).delete(delete_post).put(edit_post))
           .route("/api/forum/{room_id}/posts/{post_id}/comments", post(create_comment))
           .route("/api/forum/{room_id}/posts/{post_id}/comments/{comment_id}", delete(delete_comment).put(edit_comment))
           // Friends
           .route("/api/friends", get(get_friends))
           .route("/api/friends/status/{user_id}", get(get_friend_status))
           .route("/api/friends/request", post(send_friend_request))
           .route("/api/friends/accept", post(accept_friend_request))
           .route("/api/friends/reject", post(reject_friend_request))
           .route("/api/friends/remove", post(remove_friend))
           .route("/api/friends/block", post(block_user))
           .route("/api/friends/unblock", post(unblock_user))
           // Admin
           .route("/api/admin/stats", get(admin_stats))
           .route("/api/admin/users", get(admin_list_users))
           .route("/api/admin/users/{user_id}/disable", post(admin_disable_user))
           .route("/api/admin/users/{user_id}/enable", post(admin_enable_user))
           .route("/api/admin/users/{user_id}", delete(admin_delete_user))
           .route("/api/admin/users/{user_id}/reset-password", post(admin_reset_password))
           .route("/api/admin/rooms", get(admin_list_rooms))
           .route("/api/admin/rooms/{room_id}", delete(admin_delete_room))
           // SPA fallback for invite pages
           .route("/invite/{code}", get(serve_client))
           // WebSocket
           .route("/ws", get(ws_upgrade))
   }
