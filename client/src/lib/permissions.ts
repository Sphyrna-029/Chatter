import type { AppState } from "./store/types";

/**
 * Mirrors `can_manage_messages` in src/backend/helpers.rs: owners and moderators
 * always qualify, a member qualifies through a custom role granting
 * `manage_messages`, and every member of a DM qualifies. The server enforces
 * this too — this copy only decides whether to show the control.
 */
export function canManageMessages(state: AppState): boolean {
  if (!state.userId || !state.currentRoomId) return false;

  const myRole = state.roomMembers.find((m) => m.userId === state.userId)?.role || "member";
  if (myRole === "owner" || myRole === "moderator") return true;

  if (state.roomInfoMap[state.currentRoomId]?.is_direct) return true;

  const myRoleIds = state.memberCustomRoles[state.userId] || [];
  return myRoleIds.some(
    (rid) => state.customRoles.find((r) => r.role_id === rid)?.permissions?.manage_messages
  );
}
