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
}

#[derive(Deserialize)]
pub(crate) struct RefreshTokenRequest {
    pub(crate) refresh_token: String,
}
