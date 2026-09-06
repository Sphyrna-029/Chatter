//! A record of who did what to whom.
//!
//! Kicks, bans, role changes and deletions left no trace anywhere, so when two
//! moderators disagreed about what happened there was no answer. In a small
//! community that is how a disagreement becomes a split.
//!
//! Entries are append-only and are never edited or deleted through the API —
//! a log a moderator can rewrite is not a log. They record the actor, the
//! target, and enough detail to say what changed, but never message bodies:
//! this is a record of moderation, not a second copy of the conversation.

use super::{helpers::now_millis, state::AppState};
use mongodb::bson::doc;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// What happened. Stored as a stable string so old entries keep meaning
/// something after this list grows.
#[derive(Clone, Copy)]
pub(crate) enum AuditAction {
    MemberKicked,
    MemberBanned,
    MemberUnbanned,
    MemberRoleChanged,
    MemberRolesAssigned,
    RoleCreated,
    RoleUpdated,
    RoleDeleted,
    ChannelCreated,
    ChannelUpdated,
    ChannelDeleted,
    MessageDeleted,
    RoomSettingsUpdated,
    InviteCreated,
    InviteDeleted,
}

impl AuditAction {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::MemberKicked => "member.kicked",
            Self::MemberBanned => "member.banned",
            Self::MemberUnbanned => "member.unbanned",
            Self::MemberRoleChanged => "member.role_changed",
            Self::MemberRolesAssigned => "member.roles_assigned",
            Self::RoleCreated => "role.created",
            Self::RoleUpdated => "role.updated",
            Self::RoleDeleted => "role.deleted",
            Self::ChannelCreated => "channel.created",
            Self::ChannelUpdated => "channel.updated",
            Self::ChannelDeleted => "channel.deleted",
            Self::MessageDeleted => "message.deleted",
            Self::RoomSettingsUpdated => "room.settings_updated",
            Self::InviteCreated => "invite.created",
            Self::InviteDeleted => "invite.deleted",
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct AuditEntry {
    #[serde(rename = "_id")]
    pub(crate) entry_id: String,
    pub(crate) room_id: String,
    /// Who performed the action.
    pub(crate) actor_id: String,
    pub(crate) action: String,
    /// Who or what it was performed on — a user id, channel id, role id.
    #[serde(default)]
    pub(crate) target_id: String,
    /// A short human-readable summary of what changed. Never message content.
    #[serde(default)]
    pub(crate) detail: String,
    pub(crate) created_at: i64,
}

/// Append an entry. Best effort by design: a moderation action that succeeded
/// must not be reported as failed because the log write did, so the result is
/// deliberately ignored by callers.
pub(crate) async fn record(
    state: &Arc<AppState>,
    room_id: &str,
    actor_id: &str,
    action: AuditAction,
    target_id: &str,
    detail: &str,
) {
    let entry = AuditEntry {
        entry_id: super::helpers::generate_id("audit"),
        room_id: room_id.to_string(),
        actor_id: actor_id.to_string(),
        action: action.as_str().to_string(),
        target_id: target_id.to_string(),
        // Bounded: a caller building this from user input must not be able to
        // write an unbounded document per action.
        detail: detail.chars().take(500).collect(),
        created_at: now_millis(),
    };
    let _ = state
        .db
        .collection::<AuditEntry>("audit_log")
        .insert_one(entry)
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn action_strings_are_stable_and_namespaced() {
        // Stored verbatim, so a rename silently reinterprets old entries.
        assert_eq!(AuditAction::MemberKicked.as_str(), "member.kicked");
        assert_eq!(AuditAction::ChannelDeleted.as_str(), "channel.deleted");
        assert_eq!(
            AuditAction::RoomSettingsUpdated.as_str(),
            "room.settings_updated"
        );
    }

    #[test]
    fn every_action_is_namespaced_by_its_subject() {
        // The client groups and filters on the prefix.
        for action in [
            AuditAction::MemberKicked,
            AuditAction::MemberBanned,
            AuditAction::MemberUnbanned,
            AuditAction::MemberRoleChanged,
            AuditAction::MemberRolesAssigned,
            AuditAction::RoleCreated,
            AuditAction::RoleUpdated,
            AuditAction::RoleDeleted,
            AuditAction::ChannelCreated,
            AuditAction::ChannelUpdated,
            AuditAction::ChannelDeleted,
            AuditAction::MessageDeleted,
            AuditAction::RoomSettingsUpdated,
            AuditAction::InviteCreated,
            AuditAction::InviteDeleted,
        ] {
            let s = action.as_str();
            assert!(s.contains('.'), "{s} is not namespaced");
            assert_eq!(s.to_lowercase(), s, "{s} is not lowercase");
        }
    }
}
