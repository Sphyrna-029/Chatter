import type { AppState } from "./store/types";
import type { RolePermissions } from "./api";

/**
 * A permission as the client understands it. The server computes the
 * authoritative answer (see `effective_permissions` in src/backend/helpers.rs)
 * and the client mirrors it purely to decide which controls to show — every
 * check here is re-run server-side before anything happens.
 *
 * Falls back to permissive while `myPermissions` is still loading, so controls
 * don't flicker out on room switch; the server refuses anything unearned.
 */
export function can(state: AppState, permission: keyof RolePermissions): boolean {
  if (!state.userId || !state.currentRoomId) return false;
  if (!state.myPermissions) return permission !== "manage_messages";
  return state.myPermissions[permission];
}

/** Whether the user may pin, unpin, and curate other people's messages. */
export function canManageMessages(state: AppState): boolean {
  return can(state, "manage_messages");
}
