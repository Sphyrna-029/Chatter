use super::{
    constants::CHUNK_SIZE,
    routes::{
        admin::{admin_stats, admin_list_users, admin_disable_user, admin_enable_user, admin_delete_user, admin_reset_password, admin_list_rooms, admin_delete_room, admin_get_settings, admin_update_settings, admin_refresh_invite},
        auth::{account_status, change_password, check_username, delete_account, force_reset_password, get_recovery_codes, ice_servers, list_sessions, login, logout, recovery_login, refresh, register, revoke_session, server_info, totp_setup, totp_verify},
        channels::{list_channels, create_channel, update_channel, delete_channel, create_category, update_category, delete_category},
        forum::{create_comment, create_post, delete_comment, delete_post, edit_comment, edit_post, get_post, list_posts, search_posts},
        friends::{get_friends, get_friend_status, get_mutual_friends, send_friend_request, accept_friend_request, reject_friend_request, remove_friend, block_user, unblock_user},
        room_groups::{get_room_groups, create_room_group, update_room_group, delete_room_group, set_group_rooms, set_group_collapsed},
        roles::{list_roles, create_role, update_role, delete_role, get_member_roles, assign_member_roles, list_all_member_roles},
        invites::{accept_invite, create_invite, delete_invite, get_invite_info, list_invites},
        webhooks::{create_webhook, delete_webhook, execute_webhook, list_webhooks},
        media::{delete_upload, gif_search, link_preview, list_uploads, upload_guard, upload_chunk, upload_complete, upload_file, upload_init},
        messages::{delete_notification, delete_thread, edit_message, get_room_messages, get_room_threads, get_thread_messages, redact_message, search_messages, send_message, send_thread_message, set_thread_name},
        presence::{get_room_presence, get_voice_channel_status},
        reactions::{add_reaction, get_reactions},
        rooms::{
            add_to_dm, ban_member, create_room, delete_room, join_room, joined_rooms, kick_member,
            leave_room, list_all_rooms, list_banned_users, set_member_role, set_name_colors,
            unban_member, update_room_settings, update_room_topic,
        },
        tankwar::{get_tankwar_state, new_tankwar_game},
        tugofwar::{get_tugofwar_state, new_tugofwar_game},
        watchparty::get_watchparty_state,
        steam::{steam_callback, steam_exchange, steam_link_url, steam_login, steam_set_hide_game, steam_status, steam_unlink},
        spotify::{spotify_callback, spotify_link_url, spotify_set_hide, spotify_status, spotify_unlink},
        static_content::{build_version, serve_client, serve_invite_page, versions},
        sync::sync,
        whiteboard::get_strokes,
    },
    state::AppState,
    ws::session::ws_upgrade,
};
use axum::{
    extract::DefaultBodyLimit,
    middleware,
    routing::{delete, get, post, put},
    Router,
};
use std::sync::Arc;
use tower_http::services::ServeDir;

pub(crate) fn build_router() -> Router<Arc<AppState>> {
    // ServeDir serves static files with streaming, Range requests, etc.
    // upload_guard middleware handles auth, dangerous extensions, and MKV conversion.
    let external_router = Router::new()
        .fallback_service(ServeDir::new("external"))
        .layer(middleware::from_fn(upload_guard));

       Router::new()
           // Static / client
           .route("/", get(serve_client))
           .nest_service("/assets", ServeDir::new("client/dist/assets"))
           .nest("/external", external_router)
           // Matrix versions
           .route("/_matrix/client/versions", get(versions))
           .route("/api/version", get(build_version))
           // Auth
           .route("/_matrix/client/r0/register", post(register))
           .route("/_matrix/client/r0/login", post(login))
           .route("/_matrix/client/r0/logout", post(logout))
           .route("/_matrix/client/r0/refresh", post(refresh))
           .route("/api/check-username", post(check_username))
           .route("/api/totp/verify", post(totp_verify))
           .route("/api/totp/setup", post(totp_setup))
           .route("/api/account/status", get(account_status))
           .route("/api/account/sessions", get(list_sessions))
           .route("/api/account/sessions/{session_id}", delete(revoke_session))
           .route("/api/account/password", post(change_password))
           .route("/api/account/delete", post(delete_account))
           .route("/api/recovery-codes", post(get_recovery_codes))
           .route("/api/recovery-login", post(recovery_login))
           .route("/api/account/force-reset-password", post(force_reset_password))
           // Rooms
           .route("/_matrix/client/r0/createRoom", post(create_room))
           .route("/_matrix/client/r0/rooms/{room_id}/join", post(join_room))
           .route("/_matrix/client/r0/rooms/{room_id}/leave", post(leave_room))
           .route("/api/rooms/{room_id}/dm/invite", post(add_to_dm))
           .route("/_matrix/client/r0/joined_rooms", get(joined_rooms))
           .route("/api/rooms", get(list_all_rooms))
           .route("/api/rooms/{room_id}", delete(delete_room))
           .route(
               "/api/upload",
               post(upload_file).layer(DefaultBodyLimit::disable()),
           )
           .route("/api/upload/init", post(upload_init))
           .route(
               "/api/upload/chunk",
               post(upload_chunk).layer(DefaultBodyLimit::max(CHUNK_SIZE + 2 * 1024 * 1024)),
           )
           .route("/api/upload/complete", post(upload_complete))
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
               "/api/rooms/{room_id}/messages/{event_id}",
               delete(delete_notification),
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
           // Channels
           .route("/api/rooms/{room_id}/channels", get(list_channels).post(create_channel))
           .route("/api/rooms/{room_id}/channels/{channel_id}", put(update_channel).delete(delete_channel))
           // Custom Roles
           .route("/api/rooms/{room_id}/roles", get(list_roles).post(create_role))
           .route("/api/rooms/{room_id}/roles/{role_id}", put(update_role).delete(delete_role))
           .route("/api/rooms/{room_id}/members/{user_id}/custom-roles", get(get_member_roles).put(assign_member_roles))
           .route("/api/rooms/{room_id}/member-roles", get(list_all_member_roles))
           .route("/api/rooms/{room_id}/categories", post(create_category))
           .route("/api/rooms/{room_id}/categories/{category_id}", put(update_category).delete(delete_category))
           // Threads
           .route("/api/rooms/{room_id}/threads", get(get_room_threads))
           .route("/api/rooms/{room_id}/threads/{event_id}", get(get_thread_messages))
           .route("/api/rooms/{room_id}/threads/{event_id}/name", put(set_thread_name))
           .route("/api/rooms/{room_id}/threads/{event_id}", delete(delete_thread))
           .route("/api/rooms/{room_id}/threads/{event_id}/{txn_id}", put(send_thread_message))
           // Search
           .route("/api/rooms/{room_id}/search", get(search_messages))
           // Voice & Presence
           .route("/api/rooms/{room_id}/voice", get(get_voice_channel_status))
           .route("/api/rooms/{room_id}/presence", get(get_room_presence))
           .route("/api/gifs", get(gif_search))
           .route("/api/link-preview", get(link_preview))
           .route("/api/uploads", get(list_uploads).delete(delete_upload))
           // Invites
           .route("/api/rooms/{room_id}/invites", post(create_invite))
           .route("/api/rooms/{room_id}/invites", get(list_invites))
           .route("/api/invites/{code}", delete(delete_invite))
           .route("/api/invites/{code}", get(get_invite_info))
           .route("/api/invites/{code}/accept", post(accept_invite))
           // Webhooks
           .route("/api/rooms/{room_id}/webhooks", post(create_webhook).get(list_webhooks))
           .route("/api/webhooks/{webhook_id}", delete(delete_webhook).post(execute_webhook))
           // Tank Wars
           .route("/api/tankwar/{room_id}/state", get(get_tankwar_state))
           .route("/api/tankwar/{room_id}/new", post(new_tankwar_game))
           // Tug of War
           .route("/api/tugofwar/{room_id}/state", get(get_tugofwar_state))
           .route("/api/tugofwar/{room_id}/new", post(new_tugofwar_game))
           // Watch Party
           .route("/api/watchparty/{room_id}/state", get(get_watchparty_state))
           // Whiteboard
           .route("/api/whiteboard/{room_id}/{channel_id}/strokes", get(get_strokes))
           // Forum
           .route("/api/forum/{room_id}/posts", post(create_post).get(list_posts))
           .route("/api/forum/{room_id}/posts/search", get(search_posts))
           .route("/api/forum/{room_id}/posts/{post_id}", get(get_post).delete(delete_post).put(edit_post))
           .route("/api/forum/{room_id}/posts/{post_id}/comments", post(create_comment))
           .route("/api/forum/{room_id}/posts/{post_id}/comments/{comment_id}", delete(delete_comment).put(edit_comment))
           // Room Groups
           .route("/api/room-groups", get(get_room_groups).post(create_room_group))
           .route("/api/room-groups/{group_id}", put(update_room_group).delete(delete_room_group))
           .route("/api/room-groups/{group_id}/rooms", put(set_group_rooms))
           .route("/api/room-groups/{group_id}/collapsed", put(set_group_collapsed))
           // Friends
           .route("/api/friends", get(get_friends))
           .route("/api/friends/status/{user_id}", get(get_friend_status))
           .route("/api/friends/mutuals/{user_id}", get(get_mutual_friends))
           .route("/api/friends/request", post(send_friend_request))
           .route("/api/friends/accept", post(accept_friend_request))
           .route("/api/friends/reject", post(reject_friend_request))
           .route("/api/friends/remove", post(remove_friend))
           .route("/api/friends/block", post(block_user))
           .route("/api/friends/unblock", post(unblock_user))
           // Steam
           .route("/api/auth/steam/login", get(steam_login))
           .route("/api/auth/steam/callback", get(steam_callback))
           .route("/api/auth/steam/exchange", post(steam_exchange))
           .route("/api/steam/link-url", get(steam_link_url))
           .route("/api/steam/status", get(steam_status))
           .route("/api/steam/hide-game", put(steam_set_hide_game))
           .route("/api/steam/unlink", delete(steam_unlink))
           // Spotify
           .route("/api/auth/spotify/callback", get(spotify_callback))
           .route("/api/spotify/link-url", get(spotify_link_url))
           .route("/api/spotify/status", get(spotify_status))
           .route("/api/spotify/hide", put(spotify_set_hide))
           .route("/api/spotify/unlink", delete(spotify_unlink))
           // Server info (public)
           .route("/api/server/info", get(server_info))
           .route("/api/ice-servers", get(ice_servers))
           // Admin
           .route("/api/admin/settings", get(admin_get_settings).put(admin_update_settings))
           .route("/api/admin/settings/refresh-invite", post(admin_refresh_invite))
           .route("/api/admin/stats", get(admin_stats))
           .route("/api/admin/users", get(admin_list_users))
           .route("/api/admin/users/{user_id}/disable", post(admin_disable_user))
           .route("/api/admin/users/{user_id}/enable", post(admin_enable_user))
           .route("/api/admin/users/{user_id}", delete(admin_delete_user))
           .route("/api/admin/users/{user_id}/reset-password", post(admin_reset_password))
           .route("/api/admin/rooms", get(admin_list_rooms))
           .route("/api/admin/rooms/{room_id}", delete(admin_delete_room))
           // Invite page with OG meta tags for link previews
           .route("/invite/{code}", get(serve_invite_page))
           // WebSocket
           .route("/ws", get(ws_upgrade))
   }
