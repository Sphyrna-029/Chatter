use serde::Deserialize;

#[derive(Deserialize)]
pub(crate) struct RegisterRequest {
    pub(crate) username: String,
    pub(crate) password: String,
    pub(crate) password_confirm: Option<String>,
    pub(crate) invite_code: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct LoginRequest {
    pub(crate) username: String,
    pub(crate) password: String,
    pub(crate) totp_code: Option<String>,
    pub(crate) device_id: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct CheckUsernameRequest {
    pub(crate) username: String,
}

#[derive(Deserialize)]
pub(crate) struct TotpVerifyRequest {
    pub(crate) user_id: String,
    pub(crate) code: String,
}

#[derive(Deserialize)]
pub(crate) struct ChangePasswordRequest {
    pub(crate) totp_code: String,
    pub(crate) new_password: String,
}

#[derive(Deserialize)]
pub(crate) struct DeleteAccountRequest {
    pub(crate) totp_code: String,
}

#[derive(Deserialize)]
pub(crate) struct RecoveryCodesRequest {
    pub(crate) totp_code: String,
}

#[derive(Deserialize)]
pub(crate) struct ForceResetPasswordRequest {
    pub(crate) new_password: String,
}

#[derive(Deserialize)]
pub(crate) struct RecoveryLoginRequest {
    pub(crate) username: String,
    pub(crate) recovery_code: String,
}

#[derive(Deserialize)]
pub(crate) struct CreateRoomRequest {
    pub(crate) name: Option<String>,
    pub(crate) topic: Option<String>,
    pub(crate) invite: Option<Vec<String>>,
    pub(crate) is_direct: Option<bool>,
    pub(crate) tags: Option<Vec<String>>,
    pub(crate) icon_url: Option<String>,
    pub(crate) unlisted: Option<bool>,
    pub(crate) password: Option<String>,
    pub(crate) room_type: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct SendMessageRequest {
    pub(crate) msgtype: Option<String>,
    pub(crate) body: String,
    pub(crate) in_reply_to: Option<String>,
    pub(crate) spoiler: Option<bool>,
    pub(crate) channel_id: Option<String>,
    pub(crate) showcase_pane: Option<String>, // "featured" | "community" for showcase channels
    pub(crate) embeds: Option<Vec<serde_json::Value>>,
}

#[derive(Deserialize)]
pub(crate) struct SyncQuery {
    #[allow(dead_code)]
    pub(crate) timeout: Option<u64>,
}

#[derive(Deserialize)]
pub(crate) struct MessagesQuery {
    pub(crate) limit: Option<usize>,
    /// Scroll back: everything strictly older than this cursor, which is the
    /// oldest message the client already holds. Paired with `before_event_id`
    /// because timestamps are milliseconds and collide.
    pub(crate) before_ts: Option<i64>,
    pub(crate) before_event_id: Option<String>,
    pub(crate) around_ts: Option<i64>,
    /// Everything newer than this cursor, oldest first. Used to close the gap
    /// after a dropped WebSocket, where the client knows exactly how far it
    /// got and needs what came after — not another page from the end.
    pub(crate) after_ts: Option<i64>,
    pub(crate) after_event_id: Option<String>,
    pub(crate) channel_id: Option<String>,
    pub(crate) showcase_pane: Option<String>, // "featured" | "community" for showcase channels
}

#[derive(Deserialize)]
pub(crate) struct PinsQuery {
    pub(crate) channel_id: Option<String>,
    pub(crate) limit: Option<i64>,
    pub(crate) offset: Option<u64>,
}

#[derive(Deserialize)]
pub(crate) struct ReactionRequest {
    pub(crate) emoji: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct UpdateTopicRequest {
    pub(crate) topic: String,
}

#[derive(Deserialize)]
pub(crate) struct AddToDmRequest {
    pub(crate) user_id: String,
}

#[derive(Deserialize)]
pub(crate) struct EditMessageRequest {
    pub(crate) body: String,
    pub(crate) embeds: Option<Vec<serde_json::Value>>,
}

#[derive(Deserialize)]
pub(crate) struct LinkPreviewQuery {
    pub(crate) url: String,
}

#[derive(Deserialize)]
pub(crate) struct UpdateRoomSettingsRequest {
    pub(crate) name: Option<String>,
    pub(crate) icon_url: Option<String>,
    pub(crate) tags: Option<Vec<String>>,
    pub(crate) custom_emojis: Option<Vec<String>>,
    pub(crate) emoji_aliases: Option<std::collections::HashMap<String, String>>,
    pub(crate) unlisted: Option<bool>,
    pub(crate) password: Option<String>,
    pub(crate) remove_password: Option<bool>,
    pub(crate) read_only: Option<bool>,
    pub(crate) banner_url: Option<String>,
    /// Event name -> sound URL. An empty URL clears that event back to the
    /// client's built-in sound.
    pub(crate) sounds: Option<std::collections::HashMap<String, String>>,
    pub(crate) entrance_sounds_enabled: Option<bool>,
}

#[derive(Deserialize)]
pub(crate) struct JoinRoomRequest {
    pub(crate) password: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct RefreshTokenRequest {
    /// Clients may send the refresh token in the JSON body for backward
    /// compatibility.  New clients omit this and rely on the HttpOnly cookie.
    pub(crate) refresh_token: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct SearchQuery {
    pub(crate) q: String,
    pub(crate) filter: Option<String>,
    pub(crate) limit: Option<i64>,
    pub(crate) offset: Option<u64>,
    pub(crate) file_type: Option<String>,
    pub(crate) channel_id: Option<String>,
    pub(crate) no_channel_only: Option<bool>,
}

#[derive(Deserialize)]
pub(crate) struct SetRoleRequest {
    pub(crate) role: String,
}

#[derive(Deserialize)]
pub(crate) struct SetNameColorRequest {
    pub(crate) owner_color: Option<String>,
    pub(crate) mod_color: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct CreateForumPostRequest {
    pub(crate) title: String,
    pub(crate) body: String,
    pub(crate) image_url: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct CreateForumCommentRequest {
    pub(crate) body: String,
    pub(crate) image_url: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct EditForumPostRequest {
    pub(crate) title: Option<String>,
    pub(crate) body: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct EditForumCommentRequest {
    pub(crate) body: String,
}

#[derive(Deserialize)]
pub(crate) struct ForumPostsQuery {
    pub(crate) limit: Option<i64>,
    pub(crate) before: Option<i64>,
    pub(crate) sort: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct ForumSearchQuery {
    pub(crate) q: String,
    pub(crate) limit: Option<i64>,
}

#[derive(Deserialize)]
pub(crate) struct FriendActionRequest {
    pub(crate) user_id: String,
}

#[derive(Deserialize, Default)]
pub(crate) struct CreateInviteRequest {
    pub(crate) expires_in_days: Option<u64>,
}

#[derive(Deserialize)]
pub(crate) struct CreateBotRequest {
    pub(crate) name: String,
    pub(crate) avatar_url: Option<String>,
    pub(crate) description: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct CreateWebhookRequest {
    pub(crate) name: String,
    pub(crate) avatar_url: Option<String>,
    pub(crate) channel_id: Option<String>,
    pub(crate) require_secret: Option<bool>,
}

#[derive(Deserialize)]
pub(crate) struct CreateRoomGroupRequest {
    pub(crate) name: String,
}

#[derive(Deserialize)]
pub(crate) struct UpdateRoomGroupRequest {
    pub(crate) name: Option<String>,
    pub(crate) position: Option<i32>,
}

#[derive(Deserialize)]
pub(crate) struct SetGroupRoomsRequest {
    pub(crate) room_ids: Vec<String>,
}

#[derive(Deserialize)]
pub(crate) struct SetGroupCollapsedRequest {
    pub(crate) collapsed: bool,
}

#[derive(Deserialize)]
pub(crate) struct SetThreadNameRequest {
    pub(crate) name: String,
}

#[derive(Deserialize)]
pub(crate) struct ThreadListQuery {
    pub(crate) q: Option<String>,
    pub(crate) channel_id: Option<String>,
    pub(crate) no_channel_only: Option<bool>,
    /// Only threads with a reply newer than this many milliseconds ago. The
    /// channel list's preview asks for a 3-day window; the thread browser
    /// omits it and sees everything.
    pub(crate) active_within_ms: Option<i64>,
    pub(crate) limit: Option<usize>,
    pub(crate) offset: Option<usize>,
}

#[derive(Deserialize)]
pub(crate) struct GifSearchQuery {
    pub(crate) q: Option<String>,
    pub(crate) page: Option<u32>,
    pub(crate) per_page: Option<u32>,
}

#[derive(Deserialize)]
pub(crate) struct CreateChannelRequest {
    pub(crate) name: String,
    pub(crate) channel_type: String,
    pub(crate) topic: Option<String>,
    pub(crate) category_id: Option<String>,
    pub(crate) bot_id: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct UpdateChannelRequest {
    pub(crate) name: Option<String>,
    pub(crate) topic: Option<String>,
    pub(crate) position: Option<i32>,
    pub(crate) category_id: Option<String>,
    pub(crate) read_only: Option<bool>,
    pub(crate) slowmode_secs: Option<u32>,
    pub(crate) view_roles: Option<Vec<String>>,
    pub(crate) write_roles: Option<Vec<String>>,
    pub(crate) overwrites: Option<Vec<super::state::PermissionOverwrite>>,
    pub(crate) inherit_category_permissions: Option<bool>,
    pub(crate) showcase_write_roles: Option<Vec<String>>,
    pub(crate) showcase_posters: Option<Vec<String>>,
    pub(crate) system_channel: Option<bool>,
    pub(crate) voice_bitrate: Option<i32>,
}

#[derive(Deserialize)]
pub(crate) struct CreateCustomRoleRequest {
    pub(crate) name: String,
    pub(crate) color: Option<String>,
    pub(crate) permissions: Option<super::state::RolePermissions>,
}

#[derive(Deserialize)]
pub(crate) struct UpdateCustomRoleRequest {
    pub(crate) name: Option<String>,
    pub(crate) color: Option<String>,
    pub(crate) position: Option<i32>,
    pub(crate) permissions: Option<super::state::RolePermissions>,
}

#[derive(Deserialize)]
pub(crate) struct PermissionsQuery {
    pub(crate) channel_id: Option<String>,
    /// Resolve as this member instead of the caller (needs manage_roles).
    pub(crate) as_user: Option<String>,
    /// Resolve as a hypothetical member holding only this role.
    pub(crate) as_role: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct AssignMemberRolesRequest {
    pub(crate) role_ids: Vec<String>,
}

#[derive(Deserialize)]
pub(crate) struct CreateCategoryRequest {
    pub(crate) name: String,
}

#[derive(Deserialize)]
pub(crate) struct UpdateCategoryRequest {
    pub(crate) name: Option<String>,
    pub(crate) position: Option<i32>,
    pub(crate) overwrites: Option<Vec<super::state::PermissionOverwrite>>,
}
