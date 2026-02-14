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
pub(crate) struct LinkPreviewQuery {
    pub(crate) url: String,
}
