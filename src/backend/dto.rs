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
}

#[derive(Deserialize)]
pub(crate) struct SyncQuery {
    #[allow(dead_code)]
    pub(crate) timeout: Option<u64>,
}

#[derive(Deserialize)]
pub(crate) struct MessagesQuery {
    pub(crate) limit: Option<usize>,
    pub(crate) before: Option<usize>,
    pub(crate) around_ts: Option<i64>,
    pub(crate) channel_id: Option<String>,
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
pub(crate) struct EditMessageRequest {
    pub(crate) body: String,
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
}

#[derive(Deserialize)]
pub(crate) struct JoinRoomRequest {
    pub(crate) password: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct RefreshTokenRequest {
    pub(crate) refresh_token: String,
}

#[derive(Deserialize)]
pub(crate) struct SearchQuery {
    pub(crate) q: String,
    pub(crate) filter: Option<String>,
    pub(crate) limit: Option<i64>,
    pub(crate) file_type: Option<String>,
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

#[derive(Deserialize)]
pub(crate) struct CreateWebhookRequest {
    pub(crate) name: String,
    pub(crate) avatar_url: Option<String>,
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
}

#[derive(Deserialize)]
pub(crate) struct UpdateChannelRequest {
    pub(crate) name: Option<String>,
    pub(crate) topic: Option<String>,
    pub(crate) position: Option<i32>,
    pub(crate) category_id: Option<String>,
    pub(crate) read_only: Option<bool>,
    pub(crate) view_roles: Option<Vec<String>>,
    pub(crate) write_roles: Option<Vec<String>>,
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
}
