import type { AppState } from "./store/types";
import type { Channel, CustomRole, PermissionName, PermissionOverwrite, RolePermissions } from "./api";

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

/**
 * Mirror of the server's overwrite resolution (`apply_overwrites` in
 * src/backend/helpers.rs), used only to decide what to *display* — the member
 * list should not name people who cannot see the channel. The server remains
 * authoritative for anything that acts.
 */
function applyOverwrites(
  base: Partial<RolePermissions>,
  overwrites: PermissionOverwrite[],
  roleIds: string[],
  userId: string,
): Partial<RolePermissions> {
  const perms = { ...base };
  const apply = (allow: PermissionName[], deny: PermissionName[]) => {
    for (const name of deny) perms[name] = false;
    for (const name of allow) perms[name] = true;
  };

  for (const ow of overwrites.filter((o) => o.target_type === "everyone")) {
    apply(ow.allow, ow.deny);
  }

  const roleOws = overwrites.filter(
    (o) => o.target_type === "role" && roleIds.includes(o.target_id),
  );
  if (roleOws.length > 0) {
    apply(
      roleOws.flatMap((o) => o.allow),
      roleOws.flatMap((o) => o.deny),
    );
  }

  for (const ow of overwrites.filter((o) => o.target_type === "user" && o.target_id === userId)) {
    apply(ow.allow, ow.deny);
  }
  return perms;
}

/** Whether a member would see this channel, for member-list filtering only.
 *  Takes the slices it reads rather than the whole state, so callers memoizing
 *  on those slices cannot go stale. */
export function memberCanViewChannel(
  roles: { customRoles: CustomRole[]; memberCustomRoles: Record<string, string[]> },
  channel: Channel | null | undefined,
  member: { userId: string; role: string },
): boolean {
  if (!channel) return true;
  // Owners and moderators bypass channel overwrites, as on the server.
  if (member.role === "owner" || member.role === "moderator") return true;

  const roleIds = roles.memberCustomRoles[member.userId] || [];
  const base: Partial<RolePermissions> = { view_channel: true };
  if (roleIds.length > 0) {
    // Roles union: any role granting view_channel is enough.
    base.view_channel = roleIds.some(
      (id) => roles.customRoles.find((r) => r.role_id === id)?.permissions?.view_channel !== false,
    );
  }

  const overwrites = channel.overwrites ?? [];
  if (overwrites.length === 0) return base.view_channel !== false;
  return applyOverwrites(base, overwrites, roleIds, member.userId).view_channel !== false;
}
