use serde::Deserialize;

#[derive(Deserialize)]
pub(crate) struct RegisterRequest {
    pub(crate) username: String,
    pub(crate) password: String,
    pub(crate) device_id: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct LoginRequest {
    pub(crate) username: String,
    pub(crate) password: String,
    pub(crate) device_id: Option<String>,
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
