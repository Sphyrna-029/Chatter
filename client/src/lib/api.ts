// HTTP API wrapper for the Matrix-compatible backend

let _accessToken: string | null = null;
let _refreshToken: string | null = null;
let _refreshPromise: Promise<boolean> | null = null;

export function setAccessToken(token: string | null) {
  _accessToken = token;
  if (token) {
    localStorage.setItem("access_token", token);
  } else {
    localStorage.removeItem("access_token");
  }
}

export function setRefreshToken(token: string | null) {
  _refreshToken = token;
  if (token) {
    localStorage.setItem("refresh_token", token);
  } else {
    localStorage.removeItem("refresh_token");
  }
}

export function getAccessToken() {
  return _accessToken;
}

export function getRefreshToken() {
  return _refreshToken;
}

export function restoreTokens() {
  _accessToken = localStorage.getItem("access_token");
  _refreshToken = localStorage.getItem("refresh_token");
}

export function clearTokens() {
  _accessToken = null;
  _refreshToken = null;
  localStorage.removeItem("access_token");
  localStorage.removeItem("refresh_token");
  localStorage.removeItem("is_admin");
  localStorage.removeItem("totp_verified");
}

export function setIsAdmin(value: boolean) {
  localStorage.setItem("is_admin", JSON.stringify(value));
}

export function getIsAdmin(): boolean {
  return JSON.parse(localStorage.getItem("is_admin") || "false");
}

export function setTotpVerified(value: boolean) {
  localStorage.setItem("totp_verified", JSON.stringify(value));
}

export function getTotpVerified(): boolean {
  return JSON.parse(localStorage.getItem("totp_verified") || "false");
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (_accessToken) {
    headers["Authorization"] = `Bearer ${_accessToken}`;
  }
  return headers;
}

// ─── Token refresh ──────────────────────────────────────────────────────────

export async function apiRefreshToken(): Promise<boolean> {
  if (!_refreshToken) return false;
  try {
    const res = await fetch("/_matrix/client/r0/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: _refreshToken }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    setAccessToken(data.access_token);
    setRefreshToken(data.refresh_token);
    if (data.is_admin !== undefined) setIsAdmin(data.is_admin);
    if (data.totp_verified !== undefined) setTotpVerified(data.totp_verified);
    return true;
  } catch {
    return false;
  }
}

async function authenticatedFetch(
  url: string,
  init?: RequestInit
): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: { ...authHeaders(), ...init?.headers },
  });

  if (res.status === 401 && _refreshToken) {
    // Deduplicate concurrent refresh attempts
    if (!_refreshPromise) {
      _refreshPromise = apiRefreshToken().finally(() => {
        _refreshPromise = null;
      });
    }
    const refreshed = await _refreshPromise;
    if (refreshed) {
      // Retry with new token
      return fetch(url, {
        ...init,
        headers: { ...authHeaders(), ...init?.headers },
      });
    }
  }

  return res;
}

// ─── Auth ───────────────────────────────────────────────────────────────────

export async function apiLogin(username: string, password: string, totpCode?: string) {
  let res: Response;
  try {
    res = await fetch("/_matrix/client/r0/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, totp_code: totpCode }),
    });
  } catch {
    throw new Error("Cannot reach server. Is the backend running on :8000?");
  }
  if (!res.ok) {
    try {
      const body = await res.json();
      throw new Error(body.error || "Login failed");
    } catch (e: any) {
      if (e.message && !e.message.includes("JSON")) throw e;
      throw new Error(
        res.status === 502 || res.status === 504
          ? "Cannot reach server. Is the backend running on :8000?"
          : "Login failed"
      );
    }
  }
  return res.json() as Promise<{
    access_token: string;
    refresh_token: string;
    user_id: string;
    requires_totp?: boolean;
    is_admin?: boolean;
    totp_verified?: boolean;
  }>;
}

export async function apiRegister(username: string, password: string, passwordConfirm: string, inviteCode?: string) {
  let res: Response;
  try {
    res = await fetch("/_matrix/client/r0/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, password_confirm: passwordConfirm, invite_code: inviteCode || undefined }),
    });
  } catch {
    throw new Error("Cannot reach server. Is the backend running on :8000?");
  }
  if (!res.ok) {
    try {
      const body = await res.json();
      throw new Error(body.error || "Registration failed");
    } catch (e: any) {
      if (e.message && !e.message.includes("JSON")) throw e;
      throw new Error(
        res.status === 502 || res.status === 504
          ? "Cannot reach server. Is the backend running on :8000?"
          : "Registration failed"
      );
    }
  }
  return res.json() as Promise<{
    user_id: string;
    totp_secret: string;
    totp_uri: string;
    totp_qr_base64: string;
    is_admin?: boolean;
  }>;
}

export async function apiCheckUsername(username: string) {
  const res = await fetch("/api/check-username", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username }),
  });
  if (!res.ok) throw new Error("Failed to check username");
  return res.json() as Promise<{ available: boolean }>;
}

export async function apiVerifyTotp(userId: string, code: string) {
  const res = await fetch("/api/totp/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId, code }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || "TOTP verification failed");
  }
  return res.json() as Promise<{
    verified: boolean;
    recovery_codes?: string[];
    access_token: string;
    refresh_token: string;
    user_id: string;
    is_admin?: boolean;
    totp_verified?: boolean;
  }>;
}

export async function apiRecoveryLogin(username: string, recoveryCode: string) {
  const res = await fetch("/api/recovery-login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, recovery_code: recoveryCode }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || "Recovery login failed");
  }
  return res.json() as Promise<{
    user_id: string;
    access_token: string;
    refresh_token: string;
    device_id: string;
    is_admin?: boolean;
    totp_verified?: boolean;
    must_reset_password?: boolean;
    recovery_codes_remaining: number;
  }>;
}

export async function apiForceResetPassword(newPassword: string) {
  const res = await authenticatedFetch("/api/account/force-reset-password", {
    method: "POST",
    body: JSON.stringify({ new_password: newPassword }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || "Failed to reset password");
  }
  return res.json() as Promise<{ success: boolean }>;
}

export async function apiSetupTotp() {
  const res = await authenticatedFetch("/api/totp/setup", {
    method: "POST",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || "Failed to set up 2FA");
  }
  return res.json() as Promise<{
    totp_secret: string;
    totp_uri: string;
    totp_qr_base64: string;
  }>;
}

export async function apiChangePassword(totpCode: string, newPassword: string) {
  const res = await authenticatedFetch("/api/account/password", {
    method: "POST",
    body: JSON.stringify({ totp_code: totpCode, new_password: newPassword }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || "Failed to change password");
  }
  return res.json() as Promise<{ success: boolean }>;
}

export async function apiDeleteAccount(totpCode: string) {
  const res = await authenticatedFetch("/api/account/delete", {
    method: "POST",
    body: JSON.stringify({ totp_code: totpCode }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || "Failed to delete account");
  }
  return res.json() as Promise<{ deleted: boolean }>;
}

export async function apiGetRecoveryCodes(totpCode: string) {
  const res = await authenticatedFetch("/api/recovery-codes", {
    method: "POST",
    body: JSON.stringify({ totp_code: totpCode }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || "Failed to get recovery codes");
  }
  return res.json() as Promise<{ recovery_codes: string[] }>;
}

export async function apiGetWatchPartyState(roomId: string): Promise<{
  video_url: string;
  playing: boolean;
  position_secs: number;
  position_updated_at: number;
  host_user_id: string;
  duration_secs: number;
}> {
  const res = await authenticatedFetch(`/api/watchparty/${roomId}/state`);
  if (!res.ok) return { video_url: "", playing: false, position_secs: 0, position_updated_at: 0, host_user_id: "", duration_secs: 0 };
  return res.json();
}

export async function apiGetAccountStatus() {
  const res = await authenticatedFetch("/api/account/status");
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || "Failed to get account status");
  }
  return res.json() as Promise<{ totp_verified: boolean }>;
}

export async function apiLogout() {
  await authenticatedFetch("/_matrix/client/r0/logout", {
    method: "POST",
  });
}

// ─── Rooms ──────────────────────────────────────────────────────────────────

export async function apiGetJoinedRooms() {
  const res = await authenticatedFetch("/_matrix/client/r0/joined_rooms");
  if (!res.ok) throw new Error("Failed to load rooms");
  return res.json() as Promise<{ joined_rooms: string[] }>;
}

export async function apiSync() {
  const res = await authenticatedFetch("/_matrix/client/r0/sync?timeout=0");
  if (!res.ok) throw new Error("Sync failed");
  return res.json();
}

export async function apiCreateRoom(name: string, topic: string, tags?: string[], iconUrl?: string, unlisted?: boolean, password?: string, roomType?: string) {
  const res = await authenticatedFetch("/_matrix/client/r0/createRoom", {
    method: "POST",
    body: JSON.stringify({ name, topic, tags, icon_url: iconUrl, unlisted, password, room_type: roomType }),
  });
  if (!res.ok) throw new Error("Failed to create room");
  return res.json() as Promise<{ room_id: string }>;
}

export async function apiJoinRoom(roomId: string, password?: string) {
  const res = await authenticatedFetch(`/_matrix/client/r0/rooms/${roomId}/join`, {
    method: "POST",
    body: JSON.stringify({ password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || "Failed to join room");
  }
  return res.json();
}

export async function apiLeaveRoom(roomId: string) {
  const res = await authenticatedFetch(`/_matrix/client/r0/rooms/${roomId}/leave`, {
    method: "POST",
  });
  if (!res.ok) throw new Error("Failed to leave room");
  return res.json();
}

export interface RoomSummary {
  room_id: string;
  name: string;
  member_count: number;
  voice_count: number;
  screen_share_active?: boolean;
  tags?: string[];
  icon_url?: string;
  has_password?: boolean;
  room_type?: string;
}

export async function apiGetAllRooms() {
  const res = await authenticatedFetch("/api/rooms");
  if (!res.ok) throw new Error("Failed to load rooms");
  return res.json() as Promise<{
    rooms: RoomSummary[];
  }>;
}

// ─── Messages ───────────────────────────────────────────────────────────────

export async function apiGetMessages(roomId: string, limit = 50, before?: number, aroundTs?: number, channelId?: string) {
  let url = `/_matrix/client/r0/rooms/${roomId}/messages?limit=${limit}`;
  if (before !== undefined) url += `&before=${before}`;
  if (aroundTs !== undefined) url += `&around_ts=${aroundTs}`;
  if (channelId) url += `&channel_id=${encodeURIComponent(channelId)}`;
  const res = await authenticatedFetch(url);
  if (!res.ok) throw new Error("Failed to load messages");
  return res.json() as Promise<{
    chunk: MatrixMessage[];
    start: number;
    end: number;
    has_more: boolean;
  }>;
}

export async function apiSendMessage(roomId: string, body: string, inReplyTo?: string, spoiler?: boolean, channelId?: string) {
  const txnId = Date.now();
  const payload: Record<string, string | boolean> = { msgtype: "m.text", body };
  if (inReplyTo) {
    payload.in_reply_to = inReplyTo;
  }
  if (spoiler) {
    payload.spoiler = true;
  }
  if (channelId) {
    payload.channel_id = channelId;
  }
  const res = await authenticatedFetch(
    `/_matrix/client/r0/rooms/${roomId}/send/m.room.message/${txnId}`,
    {
      method: "PUT",
      body: JSON.stringify(payload),
    }
  );
  if (!res.ok) throw new Error("Failed to send message");
  return res.json();
}

export async function apiDeleteMessage(roomId: string, eventId: string) {
  const txnId = Date.now();
  const res = await authenticatedFetch(
    `/_matrix/client/r0/rooms/${roomId}/redact/${eventId}/${txnId}`,
    {
      method: "DELETE",
    }
  );
  if (!res.ok) throw new Error("Failed to delete message");
  return res.json();
}

export async function apiEditMessage(roomId: string, eventId: string, newBody: string) {
  const txnId = Date.now();
  const res = await authenticatedFetch(
    `/_matrix/client/r0/rooms/${roomId}/edit/${eventId}/${txnId}`,
    {
      method: "PUT",
      body: JSON.stringify({ body: newBody }),
    }
  );
  if (!res.ok) throw new Error("Failed to edit message");
  return res.json();
}

export async function apiAddReaction(
  roomId: string,
  eventId: string,
  emoji: string
) {
  const res = await authenticatedFetch(
    `/_matrix/client/r0/rooms/${roomId}/send/m.reaction/${eventId}`,
    {
      method: "PUT",
      body: JSON.stringify({ emoji }),
    }
  );
  if (!res.ok) throw new Error("Failed to add reaction");
  return res.json();
}

// ─── Threads ─────────────────────────────────────────────────────────────────

export async function apiGetThreadMessages(roomId: string, threadEventId: string) {
  const res = await authenticatedFetch(`/api/rooms/${roomId}/threads/${threadEventId}`);
  if (!res.ok) throw new Error("Failed to load thread messages");
  return res.json() as Promise<{ root: MatrixMessage; messages: MatrixMessage[] }>;
}

export async function apiGetRoomThreads(roomId: string, query?: string): Promise<MatrixMessage[]> {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  const res = await authenticatedFetch(`/api/rooms/${roomId}/threads?${params}`);
  if (!res.ok) throw new Error("Failed to load threads");
  const data = await res.json();
  return data.threads as MatrixMessage[];
}

export async function apiSetThreadName(roomId: string, threadEventId: string, name: string) {
  const res = await authenticatedFetch(
    `/api/rooms/${roomId}/threads/${threadEventId}/name`,
    { method: "PUT", body: JSON.stringify({ name }) }
  );
  if (!res.ok) throw new Error("Failed to set thread name");
}

export async function apiSendThreadMessage(roomId: string, threadEventId: string, body: string) {
  const txnId = Date.now();
  const res = await authenticatedFetch(
    `/api/rooms/${roomId}/threads/${threadEventId}/${txnId}`,
    {
      method: "PUT",
      body: JSON.stringify({ msgtype: "m.text", body }),
    }
  );
  if (!res.ok) throw new Error("Failed to send thread message");
  return res.json();
}

// ─── Search ──────────────────────────────────────────────────────────────────

export async function apiSearchMessages(
  roomId: string,
  query: string,
  filter: string = "all",
  fileType: string = "all"
): Promise<MatrixMessage[]> {
  const params = new URLSearchParams({ q: query, filter });
  if (filter === "file" && fileType !== "all") {
    params.set("file_type", fileType);
  }
  const res = await authenticatedFetch(`/api/rooms/${roomId}/search?${params}`);
  if (!res.ok) throw new Error("Search failed");
  const data = await res.json();
  return data.results as MatrixMessage[];
}

// ─── Voice & Presence ───────────────────────────────────────────────────────

export async function apiGetVoiceMembers(roomId: string) {
  const res = await authenticatedFetch(`/api/rooms/${roomId}/voice`);
  if (!res.ok) throw new Error("Failed to load voice members");
  return res.json() as Promise<{
    voice_members: VoiceMember[];
    voice_channels?: Record<string, { userId: string; muted: boolean; deafened: boolean; screen_sharing: boolean }[]>;
    occupied_since?: Record<string, number>;
  }>;
}

export async function apiGetPresence(roomId: string) {
  const res = await authenticatedFetch(`/api/rooms/${roomId}/presence`);
  if (!res.ok) throw new Error("Failed to load presence");
  return res.json() as Promise<{
    presence: Record<string, { status: string }>;
  }>;
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MatrixMessage {
  event_id: string;
  sender: string;
  room_id: string;
  origin_server_ts: number;
  type: string;
  thread_id?: string;
  thread_reply_count?: number;
  thread_name?: string;
  content: {
    body: string;
    msgtype: string;
    spoiler?: boolean;
    in_reply_to?: string;
    reply_to_sender?: string;
    reply_to_body?: string;
    reply_to_spoiler?: boolean;
    webhook?: boolean;
    webhook_name?: string;
    webhook_avatar_url?: string;
  };
  redacted?: boolean;
  edited?: boolean;
  edited_at?: number;
  reactions?: Record<string, string[]>;
}

export interface VoiceMember {
  user_id: string;
  muted: boolean;
  deafened: boolean;
  screen_sharing: boolean;
}

export interface RoomInfo {
  room_id: string;
  name: string;
  topic: string;
  is_direct?: boolean;
  tags?: string[];
  icon_url?: string;
  creator?: string;
  custom_emojis?: string[];
  emoji_aliases?: Record<string, string>;
  owner_name_color?: string;
  mod_name_color?: string;
  unlisted?: boolean;
  has_password?: boolean;
  room_type?: string;
  read_only?: boolean;
  banner_url?: string;
}

// ─── Channels ───────────────────────────────────────────────────────────────

export interface ChannelCategory {
  category_id: string;
  name: string;
  position: number;
}

export interface Channel {
  channel_id: string;
  room_id?: string;
  name: string;
  channel_type: "text" | "voice";
  topic: string;
  position: number;
  category_id?: string;
  read_only?: boolean;
  view_roles?: string[];
  write_roles?: string[];
  system_channel?: boolean;
  created_by?: string;
  created_at?: number;
}

// ─── Custom Roles ────────────────────────────────────────────────────────────

export interface RolePermissions {
  send_messages: boolean;
  manage_channels: boolean;
  manage_roles: boolean;
  manage_messages: boolean;
  kick_members: boolean;
  ban_members: boolean;
  mention_everyone: boolean;
}

export interface CustomRole {
  role_id: string;
  room_id: string;
  name: string;
  color: string;
  position: number;
  permissions: RolePermissions;
  created_by?: string;
  created_at?: number;
}

export async function apiGetRoles(roomId: string) {
  const res = await authenticatedFetch(`/api/rooms/${encodeURIComponent(roomId)}/roles`);
  if (!res.ok) throw new Error("Failed to load roles");
  return res.json() as Promise<{ roles: CustomRole[] }>;
}

export async function apiCreateRole(roomId: string, data: { name: string; color?: string; permissions?: Partial<RolePermissions> }) {
  const res = await authenticatedFetch(`/api/rooms/${encodeURIComponent(roomId)}/roles`, {
    method: "POST",
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Failed" }));
    throw new Error(err.error || "Failed to create role");
  }
  return res.json() as Promise<{ role_id: string }>;
}

export async function apiUpdateRole(roomId: string, roleId: string, data: { name?: string; color?: string; position?: number; permissions?: Partial<RolePermissions> }) {
  const res = await authenticatedFetch(`/api/rooms/${encodeURIComponent(roomId)}/roles/${encodeURIComponent(roleId)}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Failed" }));
    throw new Error(err.error || "Failed to update role");
  }
  return res.json();
}

export async function apiDeleteRole(roomId: string, roleId: string) {
  const res = await authenticatedFetch(`/api/rooms/${encodeURIComponent(roomId)}/roles/${encodeURIComponent(roleId)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Failed" }));
    throw new Error(err.error || "Failed to delete role");
  }
  return res.json();
}

export async function apiGetAllMemberRoles(roomId: string) {
  const res = await authenticatedFetch(`/api/rooms/${encodeURIComponent(roomId)}/member-roles`);
  if (!res.ok) throw new Error("Failed to load member roles");
  return res.json() as Promise<{ member_roles: Record<string, string[]> }>;
}

export async function apiAssignMemberRoles(roomId: string, userId: string, roleIds: string[]) {
  const res = await authenticatedFetch(`/api/rooms/${encodeURIComponent(roomId)}/members/${encodeURIComponent(userId)}/custom-roles`, {
    method: "PUT",
    body: JSON.stringify({ role_ids: roleIds }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Failed" }));
    throw new Error(err.error || "Failed to assign roles");
  }
  return res.json();
}

export async function apiGetChannels(roomId: string) {
  const res = await authenticatedFetch(`/api/rooms/${roomId}/channels`);
  if (!res.ok) throw new Error("Failed to load channels");
  return res.json() as Promise<{ channels: Channel[]; categories: ChannelCategory[] }>;
}

export async function apiCreateChannel(roomId: string, data: { name: string; channel_type: string; topic?: string; category_id?: string }) {
  const res = await authenticatedFetch(`/api/rooms/${roomId}/channels`, {
    method: "POST",
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Failed" }));
    throw new Error(err.error || "Failed to create channel");
  }
  return res.json() as Promise<{ channel_id: string }>;
}

export async function apiUpdateChannel(roomId: string, channelId: string, data: { name?: string; topic?: string; position?: number; category_id?: string; read_only?: boolean; view_roles?: string[]; write_roles?: string[]; system_channel?: boolean }) {
  const res = await authenticatedFetch(`/api/rooms/${encodeURIComponent(roomId)}/channels/${encodeURIComponent(channelId)}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Failed" }));
    throw new Error(err.error || "Failed to update channel");
  }
  return res.json();
}

export async function apiDeleteChannel(roomId: string, channelId: string) {
  const res = await authenticatedFetch(`/api/rooms/${encodeURIComponent(roomId)}/channels/${encodeURIComponent(channelId)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Failed" }));
    throw new Error(err.error || "Failed to delete channel");
  }
  return res.json();
}

// ─── Channel Categories ─────────────────────────────────────────────────────

export async function apiCreateCategory(roomId: string, name: string) {
  const res = await authenticatedFetch(`/api/rooms/${roomId}/categories`, {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Failed" }));
    throw new Error(err.error || "Failed to create category");
  }
  return res.json() as Promise<{ category_id: string }>;
}

export async function apiUpdateCategory(roomId: string, categoryId: string, data: { name?: string; position?: number }) {
  const res = await authenticatedFetch(`/api/rooms/${roomId}/categories/${categoryId}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Failed" }));
    throw new Error(err.error || "Failed to update category");
  }
  return res.json();
}

export async function apiDeleteCategory(roomId: string, categoryId: string) {
  const res = await authenticatedFetch(`/api/rooms/${roomId}/categories/${categoryId}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Failed" }));
    throw new Error(err.error || "Failed to delete category");
  }
  return res.json();
}

// ─── Room Settings ──────────────────────────────────────────────────────────

export async function apiUpdateTopic(roomId: string, topic: string) {
  const res = await authenticatedFetch(
    `/_matrix/client/r0/rooms/${roomId}/state/m.room.topic`,
    {
      method: "PUT",
      body: JSON.stringify({ topic }),
    }
  );
  if (!res.ok) throw new Error("Failed to update topic");
  return res.json();
}

const CLIENT_CHUNK_SIZE = 10 * 1024 * 1024; // 10MB

function uploadSingleFile(
  file: File,
  onProgress?: (pct: number) => void
): Promise<{ url: string }> {
  const formData = new FormData();
  formData.append("filename", file.name);
  formData.append("file", file);

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload");
    if (_accessToken) {
      xhr.setRequestHeader("Authorization", `Bearer ${_accessToken}`);
    }
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch {
          reject(new Error("Invalid response from server"));
        }
      } else if (xhr.status === 401 && _refreshToken) {
        if (!_refreshPromise) {
          _refreshPromise = apiRefreshToken().finally(() => {
            _refreshPromise = null;
          });
        }
        _refreshPromise.then((refreshed) => {
          if (!refreshed) {
            reject(new Error("Upload failed - authentication expired"));
            return;
          }
          const retryXhr = new XMLHttpRequest();
          retryXhr.open("POST", "/api/upload");
          if (_accessToken) {
            retryXhr.setRequestHeader("Authorization", `Bearer ${_accessToken}`);
          }
          retryXhr.onload = () => {
            if (retryXhr.status >= 200 && retryXhr.status < 300) {
              try { resolve(JSON.parse(retryXhr.responseText)); } catch { reject(new Error("Invalid response")); }
            } else {
              reject(new Error("Upload failed"));
            }
          };
          retryXhr.onerror = () => reject(new Error("Upload failed"));
          retryXhr.send(formData);
        });
      } else {
        try {
          const body = JSON.parse(xhr.responseText);
          reject(new Error(body.error || "Upload failed"));
        } catch {
          reject(new Error("Upload failed"));
        }
      }
    };
    xhr.onerror = () => reject(new Error("Upload failed"));
    xhr.send(formData);
  });
}

function uploadChunkXhr(
  uploadId: string,
  chunkIndex: number,
  blob: Blob,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append("uploadId", uploadId);
    fd.append("chunkIndex", String(chunkIndex));
    fd.append("file", blob);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload/chunk");
    if (_accessToken) {
      xhr.setRequestHeader("Authorization", `Bearer ${_accessToken}`);
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else if (xhr.status === 401 && _refreshToken) {
        if (!_refreshPromise) {
          _refreshPromise = apiRefreshToken().finally(() => { _refreshPromise = null; });
        }
        _refreshPromise.then((refreshed) => {
          if (!refreshed) { reject(new Error("Auth expired")); return; }
          const retry = new XMLHttpRequest();
          retry.open("POST", "/api/upload/chunk");
          if (_accessToken) retry.setRequestHeader("Authorization", `Bearer ${_accessToken}`);
          retry.onload = () => retry.status >= 200 && retry.status < 300 ? resolve() : reject(new Error("Chunk upload failed"));
          retry.onerror = () => reject(new Error("Chunk upload failed"));
          retry.send(fd);
        });
      } else {
        reject(new Error("Chunk upload failed"));
      }
    };
    xhr.onerror = () => reject(new Error("Chunk upload failed"));
    xhr.send(fd);
  });
}

async function uploadChunkedFile(
  file: File,
  onProgress?: (pct: number) => void
): Promise<{ url: string }> {
  // 1. Init
  const initRes = await authenticatedFetch("/api/upload/init", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename: file.name, fileSize: file.size }),
  });
  if (!initRes.ok) {
    const err = await initRes.json().catch(() => ({}));
    throw new Error(err.error || "Failed to init chunked upload");
  }
  const { uploadId } = await initRes.json();

  // 2. Upload chunks
  const totalChunks = Math.ceil(file.size / CLIENT_CHUNK_SIZE);
  for (let i = 0; i < totalChunks; i++) {
    const start = i * CLIENT_CHUNK_SIZE;
    const end = Math.min(start + CLIENT_CHUNK_SIZE, file.size);
    const blob = file.slice(start, end);
    await uploadChunkXhr(uploadId, i, blob);
    if (onProgress) {
      onProgress(Math.round(((i + 1) / totalChunks) * 100));
    }
  }

  // 3. Complete
  const completeRes = await authenticatedFetch("/api/upload/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uploadId }),
  });
  if (!completeRes.ok) {
    const err = await completeRes.json().catch(() => ({}));
    throw new Error(err.error || "Failed to complete chunked upload");
  }
  return completeRes.json();
}

export async function apiUploadFile(
  file: File,
  onProgress?: (pct: number) => void
): Promise<{ url: string }> {
  if (file.size > CLIENT_CHUNK_SIZE) {
    return uploadChunkedFile(file, onProgress);
  }
  return uploadSingleFile(file, onProgress);
}

// ─── Link previews ──────────────────────────────────────────────────────────

export interface LinkPreview {
  title?: string;
  description?: string;
  image?: string;
  site_name?: string;
}

// ─── GIF Search ──────────────────────────────────────────────────────────

export async function apiSearchGifs(query: string, page: number = 1, perPage: number = 24) {
  const params = new URLSearchParams({ page: String(page), per_page: String(perPage) });
  if (query.trim()) params.set("q", query.trim());
  const res = await authenticatedFetch(`/api/gifs?${params}`);
  if (!res.ok) throw new Error("Failed to search GIFs");
  return res.json();
}

export async function apiGetLinkPreview(url: string): Promise<LinkPreview> {
  const res = await authenticatedFetch(`/api/link-preview?url=${encodeURIComponent(url)}`);
  if (!res.ok) throw new Error("Failed to fetch link preview");
  return res.json() as Promise<LinkPreview>;
}

export async function apiUpdateRoomSettings(
  roomId: string,
  settings: { name?: string; icon_url?: string; tags?: string[]; custom_emojis?: string[]; emoji_aliases?: Record<string, string>; unlisted?: boolean; password?: string; remove_password?: boolean; read_only?: boolean; banner_url?: string }
) {
  const res = await authenticatedFetch(
    `/_matrix/client/r0/rooms/${roomId}/state/m.room.settings`,
    {
      method: "PUT",
      body: JSON.stringify(settings),
    }
  );
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || "Failed to update room settings");
  }
  return res.json();
}

// ─── Invites ────────────────────────────────────────────────────────────────

export async function apiGetInviteInfo(code: string) {
  const res = await fetch(`/api/invites/${code}`);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || "Invite not found");
  }
  return res.json() as Promise<{ room_name: string; icon_url: string; member_count: number }>;
}

export async function apiAcceptInvite(code: string) {
  const res = await authenticatedFetch(`/api/invites/${code}/accept`, {
    method: "POST",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || "Failed to accept invite");
  }
  return res.json() as Promise<{ room_id: string }>;
}

export async function apiCreateInvite(roomId: string) {
  const res = await authenticatedFetch(`/api/rooms/${roomId}/invites`, {
    method: "POST",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || "Failed to create invite");
  }
  return res.json() as Promise<{ code: string }>;
}

export async function apiListInvites(roomId: string) {
  const res = await authenticatedFetch(`/api/rooms/${roomId}/invites`);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || "Failed to list invites");
  }
  return res.json() as Promise<{
    invites: { code: string; click_count: number; created_at: number }[];
  }>;
}

export async function apiDeleteInvite(code: string) {
  const res = await authenticatedFetch(`/api/invites/${code}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || "Failed to delete invite");
  }
  return res.json();
}

// ─── User uploads ───────────────────────────────────────────────────────────

export interface UploadRecord {
  filename: string;
  url: string;
  disk_path: string;
  size: number;
  uploaded_at: number;
}

export async function apiListUploads(): Promise<UploadRecord[]> {
  const res = await authenticatedFetch("/api/uploads");
  if (!res.ok) throw new Error("Failed to list uploads");
  const data = await res.json();
  return data.files as UploadRecord[];
}

export async function apiDeleteUpload(url: string): Promise<void> {
  const res = await authenticatedFetch("/api/uploads", {
    method: "DELETE",
    body: JSON.stringify({ url }),
  });
  if (!res.ok) throw new Error("Failed to delete upload");
}

export async function apiDeleteRoom(roomId: string): Promise<void> {
  const res = await authenticatedFetch(`/api/rooms/${roomId}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || "Failed to delete room");
  }
}

// ─── Room Permissions ────────────────────────────────────────────────────────

export async function apiKickMember(roomId: string, userId: string) {
  const res = await authenticatedFetch(`/api/rooms/${roomId}/members/${userId}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || "Failed to kick member");
  }
  return res.json();
}

export async function apiBanMember(roomId: string, userId: string) {
  const res = await authenticatedFetch(`/api/rooms/${roomId}/ban/${userId}`, {
    method: "POST",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || "Failed to ban member");
  }
  return res.json();
}

export interface BannedUser {
  user_id: string;
  banned_by: string;
  banned_at: number;
}

export async function apiGetBannedUsers(roomId: string) {
  const res = await authenticatedFetch(`/api/rooms/${roomId}/bans`);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || "Failed to load banned users");
  }
  return res.json() as Promise<{ bans: BannedUser[] }>;
}

export async function apiUnbanMember(roomId: string, userId: string) {
  const res = await authenticatedFetch(`/api/rooms/${roomId}/ban/${userId}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || "Failed to unban member");
  }
  return res.json();
}

export async function apiSetMemberRole(roomId: string, userId: string, role: string) {
  const res = await authenticatedFetch(`/api/rooms/${roomId}/members/${userId}/role`, {
    method: "PUT",
    body: JSON.stringify({ role }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || "Failed to set role");
  }
  return res.json();
}

export async function apiSetNameColors(roomId: string, ownerColor?: string, modColor?: string) {
  const res = await authenticatedFetch(`/api/rooms/${roomId}/name-colors`, {
    method: "PUT",
    body: JSON.stringify({ owner_color: ownerColor, mod_color: modColor }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || "Failed to set name colors");
  }
  return res.json();
}

export async function apiCreateDM(targetUserId: string) {
  const res = await authenticatedFetch("/_matrix/client/r0/createRoom", {
    method: "POST",
    body: JSON.stringify({ is_direct: true, invite: [targetUserId] }),
  });
  if (!res.ok) throw new Error("Failed to create DM");
  return res.json() as Promise<{ room_id: string }>;
}

// ─── Forum ──────────────────────────────────────────────────────────────────

export interface ForumPost {
  post_id: string;
  room_id: string;
  author: string;
  title: string;
  body: string;
  image_url: string;
  created_at: number;
  comment_count: number;
  last_activity: number;
  reactions: Record<string, string[]>;
  edited?: boolean;
  edited_at?: number;
}

export interface ForumComment {
  comment_id: string;
  post_id: string;
  room_id: string;
  author: string;
  body: string;
  image_url: string;
  created_at: number;
  edited?: boolean;
  edited_at?: number;
}

export async function apiCreateForumPost(roomId: string, title: string, body: string, imageUrl?: string) {
  const res = await authenticatedFetch(`/api/forum/${roomId}/posts`, {
    method: "POST",
    body: JSON.stringify({ title, body, image_url: imageUrl }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || "Failed to create post");
  }
  return res.json() as Promise<{ post_id: string }>;
}

export async function apiListForumPosts(roomId: string, limit?: number, before?: number, sort?: string) {
  let url = `/api/forum/${roomId}/posts?limit=${limit || 20}`;
  if (before !== undefined) url += `&before=${before}`;
  if (sort) url += `&sort=${sort}`;
  const res = await authenticatedFetch(url);
  if (!res.ok) throw new Error("Failed to load posts");
  return res.json() as Promise<{ posts: ForumPost[]; has_more: boolean }>;
}

export async function apiGetForumPost(roomId: string, postId: string) {
  const res = await authenticatedFetch(`/api/forum/${roomId}/posts/${postId}`);
  if (!res.ok) throw new Error("Failed to load post");
  return res.json() as Promise<{ post: ForumPost; comments: ForumComment[] }>;
}

export async function apiDeleteForumPost(roomId: string, postId: string) {
  const res = await authenticatedFetch(`/api/forum/${roomId}/posts/${postId}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || "Failed to delete post");
  }
  return res.json();
}

export async function apiCreateForumComment(roomId: string, postId: string, body: string, imageUrl?: string) {
  const res = await authenticatedFetch(`/api/forum/${roomId}/posts/${postId}/comments`, {
    method: "POST",
    body: JSON.stringify({ body, image_url: imageUrl }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || "Failed to create comment");
  }
  return res.json() as Promise<{ comment_id: string }>;
}

export async function apiDeleteForumComment(roomId: string, postId: string, commentId: string) {
  const res = await authenticatedFetch(`/api/forum/${roomId}/posts/${postId}/comments/${commentId}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || "Failed to delete comment");
  }
  return res.json();
}

export async function apiSearchForumPosts(roomId: string, query: string, limit?: number) {
  const params = new URLSearchParams({ q: query });
  if (limit) params.set("limit", String(limit));
  const res = await authenticatedFetch(`/api/forum/${roomId}/posts/search?${params}`);
  if (!res.ok) throw new Error("Failed to search posts");
  return res.json() as Promise<{ posts: ForumPost[] }>;
}

export async function apiEditForumPost(roomId: string, postId: string, title?: string, body?: string) {
  const res = await authenticatedFetch(`/api/forum/${roomId}/posts/${postId}`, {
    method: "PUT",
    body: JSON.stringify({ title, body }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || "Failed to edit post");
  }
  return res.json();
}

export async function apiEditForumComment(roomId: string, postId: string, commentId: string, body: string) {
  const res = await authenticatedFetch(`/api/forum/${roomId}/posts/${postId}/comments/${commentId}`, {
    method: "PUT",
    body: JSON.stringify({ body }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || "Failed to edit comment");
  }
  return res.json();
}

// ─── Whiteboard ──────────────────────────────────────────────────────────────

export interface WhiteboardStroke {
  stroke_id: string;
  room_id?: string;
  user_id: string;
  tool: string;
  color: string;
  width: number;
  points: number[][];
  fill: boolean;
  timestamp: number;
}

export async function apiGetWhiteboardStrokes(roomId: string) {
  const res = await authenticatedFetch(`/api/whiteboard/${roomId}/strokes`);
  if (!res.ok) throw new Error("Failed to load whiteboard strokes");
  return res.json() as Promise<{ strokes: WhiteboardStroke[] }>;
}

// ─── Admin ──────────────────────────────────────────────────────────────────

export interface AdminStats {
  users: number;
  rooms: number;
  messages: number;
  uploads: number;
  total_file_size: number;
  online_users: number;
}

export interface AdminUser {
  user_id: string;
  display_name: string;
  avatar_url: string;
  is_admin: boolean;
  disabled: boolean;
  totp_verified: boolean;
  room_count: number;
  online: boolean;
}

export interface AdminRoom {
  room_id: string;
  name: string;
  creator: string;
  is_dm: boolean;
  room_type: string;
  member_count: number;
  message_count: number;
}

export async function apiGetServerInfo(): Promise<{ invite_only: boolean; require_auth_for_uploads: boolean; storage_limit_bytes: number; upload_limit_bytes: number }> {
  const res = await fetch("/api/server/info");
  if (!res.ok) throw new Error("Failed to get server info");
  return res.json();
}

export async function apiAdminGetSettings(): Promise<{ invite_only: boolean; invite_code: string; storage_limit_bytes: number; upload_limit_bytes: number; room_creation_limit: number; require_auth_for_uploads: boolean; room_creation_disabled: boolean }> {
  const res = await authenticatedFetch("/api/admin/settings");
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || "Failed to get settings");
  }
  return res.json();
}

export async function apiAdminUpdateSettings(settings: { invite_only?: boolean; storage_limit_bytes?: number; upload_limit_bytes?: number; room_creation_limit?: number; require_auth_for_uploads?: boolean; room_creation_disabled?: boolean }): Promise<void> {
  const res = await authenticatedFetch("/api/admin/settings", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || "Failed to update settings");
  }
}

export async function apiGetAuthenticatedBlobUrl(url: string): Promise<string> {
  const res = await authenticatedFetch(url);
  if (!res.ok) throw new Error("Failed to fetch media");
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

export async function apiAdminRefreshInvite(): Promise<{ invite_code: string }> {
  const res = await authenticatedFetch("/api/admin/settings/refresh-invite", {
    method: "POST",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || "Failed to refresh invite code");
  }
  return res.json();
}

export async function apiAdminGetStats(): Promise<AdminStats> {
  const res = await authenticatedFetch("/api/admin/stats");
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || "Failed to get stats");
  }
  return res.json();
}

export async function apiAdminListUsers(): Promise<AdminUser[]> {
  const res = await authenticatedFetch("/api/admin/users");
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || "Failed to list users");
  }
  const data = await res.json();
  return data.users;
}

export async function apiAdminDeleteUser(userId: string): Promise<void> {
  const username = userId.replace(/^@/, "").split(":")[0];
  const res = await authenticatedFetch(`/api/admin/users/${username}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || "Failed to delete user");
  }
}

export async function apiAdminDisableUser(userId: string): Promise<void> {
  const username = userId.replace(/^@/, "").split(":")[0];
  const res = await authenticatedFetch(`/api/admin/users/${username}/disable`, {
    method: "POST",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || "Failed to disable user");
  }
}

export async function apiAdminEnableUser(userId: string): Promise<void> {
  const username = userId.replace(/^@/, "").split(":")[0];
  const res = await authenticatedFetch(`/api/admin/users/${username}/enable`, {
    method: "POST",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || "Failed to enable user");
  }
}

export async function apiAdminResetPassword(userId: string): Promise<string> {
  const username = userId.replace(/^@/, "").split(":")[0];
  const res = await authenticatedFetch(`/api/admin/users/${username}/reset-password`, {
    method: "POST",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || "Failed to reset password");
  }
  const data = await res.json();
  return data.temporary_password;
}

export async function apiAdminListRooms(): Promise<AdminRoom[]> {
  const res = await authenticatedFetch("/api/admin/rooms");
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || "Failed to list rooms");
  }
  const data = await res.json();
  return data.rooms;
}

export async function apiAdminDeleteRoom(roomId: string): Promise<void> {
  const res = await authenticatedFetch(`/api/admin/rooms/${roomId}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || "Failed to delete room");
  }
}

// ─── Webhooks ────────────────────────────────────────────────────────────────

export interface Webhook {
  webhook_id: string;
  name: string;
  avatar_url: string;
  channel_id?: string;
  created_at: number;
  url: string;
}

export async function apiCreateWebhook(roomId: string, name: string, avatarUrl?: string, channelId?: string) {
  const res = await authenticatedFetch(`/api/rooms/${roomId}/webhooks`, {
    method: "POST",
    body: JSON.stringify({ name, avatar_url: avatarUrl, channel_id: channelId }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || "Failed to create webhook");
  }
  return res.json() as Promise<{ webhook_id: string; url: string }>;
}

export async function apiListWebhooks(roomId: string) {
  const res = await authenticatedFetch(`/api/rooms/${roomId}/webhooks`);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || "Failed to list webhooks");
  }
  return res.json() as Promise<{ webhooks: Webhook[] }>;
}

export async function apiDeleteWebhook(webhookId: string) {
  const res = await authenticatedFetch(`/api/webhooks/${webhookId}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || "Failed to delete webhook");
  }
  return res.json();
}

// ─── Room Groups ─────────────────────────────────────────────────────

export interface RoomGroup {
  group_id: string;
  name: string;
  position: number;
  collapsed: boolean;
  room_ids: string[];
}

export async function apiGetRoomGroups(): Promise<RoomGroup[]> {
  const res = await authenticatedFetch("/api/room-groups");
  if (!res.ok) throw new Error("Failed to load room groups");
  const data = await res.json();
  return data.groups;
}

export async function apiCreateRoomGroup(name: string): Promise<string> {
  const res = await authenticatedFetch("/api/room-groups", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || "Failed to create group");
  }
  const data = await res.json();
  return data.group_id;
}

export async function apiUpdateRoomGroup(groupId: string, updates: { name?: string; position?: number }): Promise<void> {
  const res = await authenticatedFetch(`/api/room-groups/${groupId}`, {
    method: "PUT",
    body: JSON.stringify(updates),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || "Failed to update group");
  }
}

export async function apiDeleteRoomGroup(groupId: string): Promise<void> {
  const res = await authenticatedFetch(`/api/room-groups/${groupId}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || "Failed to delete group");
  }
}

export async function apiSetGroupRooms(groupId: string, roomIds: string[]): Promise<void> {
  const res = await authenticatedFetch(`/api/room-groups/${groupId}/rooms`, {
    method: "PUT",
    body: JSON.stringify({ room_ids: roomIds }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || "Failed to set group rooms");
  }
}

export async function apiSetGroupCollapsed(groupId: string, collapsed: boolean): Promise<void> {
  const res = await authenticatedFetch(`/api/room-groups/${groupId}/collapsed`, {
    method: "PUT",
    body: JSON.stringify({ collapsed }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || "Failed to toggle group collapsed");
  }
}

// ─── Friends ─────────────────────────────────────────────────────────────────

export async function apiGetFriends() {
  const res = await authenticatedFetch("/api/friends");
  if (!res.ok) throw new Error("Failed to load friends");
  return res.json() as Promise<{
    friends: string[];
    incoming_requests: { userId: string; requestId: string }[];
    outgoing_requests: { userId: string; requestId: string }[];
    blocked: string[];
  }>;
}

export async function apiGetFriendStatus(userId: string) {
  const res = await authenticatedFetch(`/api/friends/status/${userId}`);
  if (!res.ok) throw new Error("Failed to get friend status");
  return res.json() as Promise<{ status: string }>;
}

export async function apiSendFriendRequest(userId: string) {
  const res = await authenticatedFetch("/api/friends/request", {
    method: "POST",
    body: JSON.stringify({ user_id: userId }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || "Failed to send friend request");
  }
  return res.json() as Promise<{ status: string; auto_accepted?: boolean }>;
}

export async function apiAcceptFriendRequest(userId: string) {
  const res = await authenticatedFetch("/api/friends/accept", {
    method: "POST",
    body: JSON.stringify({ user_id: userId }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || "Failed to accept friend request");
  }
  return res.json();
}

export async function apiRejectFriendRequest(userId: string) {
  const res = await authenticatedFetch("/api/friends/reject", {
    method: "POST",
    body: JSON.stringify({ user_id: userId }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || "Failed to reject friend request");
  }
  return res.json();
}

export async function apiRemoveFriend(userId: string) {
  const res = await authenticatedFetch("/api/friends/remove", {
    method: "POST",
    body: JSON.stringify({ user_id: userId }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || "Failed to remove friend");
  }
  return res.json();
}

export async function apiBlockUser(userId: string) {
  const res = await authenticatedFetch("/api/friends/block", {
    method: "POST",
    body: JSON.stringify({ user_id: userId }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || "Failed to block user");
  }
  return res.json();
}

export async function apiUnblockUser(userId: string) {
  const res = await authenticatedFetch("/api/friends/unblock", {
    method: "POST",
    body: JSON.stringify({ user_id: userId }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || "Failed to unblock user");
  }
  return res.json();
}

// ─── Tank Wars ────────────────────────────────────────────────────────────────

export async function apiGetTankWarState(roomId: string) {
  const res = await authenticatedFetch(`/api/tankwar/${roomId}/state`);
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || "Failed to get tank war state");
  }
  return res.json();
}

export async function apiNewTankWarGame(roomId: string, settings?: { game_mode?: string; max_ticks?: number }) {
  const res = await authenticatedFetch(`/api/tankwar/${roomId}/new`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings || {}),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || "Failed to create new game");
  }
  return res.json() as Promise<{ game_id: string }>;
}

// ─── Tug of War ───────────────────────────────────────────────────────────────

export async function apiGetTugOfWarState(roomId: string) {
  const res = await authenticatedFetch(`/api/tugofwar/${roomId}/state`);
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || "Failed to get tug of war state");
  }
  return res.json();
}

export async function apiNewTugOfWarGame(roomId: string) {
  const res = await authenticatedFetch(`/api/tugofwar/${roomId}/new`, {
    method: "POST",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || "Failed to create tug of war game");
  }
  return res.json() as Promise<{ game_id: string }>;
}


// ─── Steam ────────────────────────────────────────────────────────────────────

export async function apiGetSteamLinkUrl(): Promise<{ url: string }> {
  const res = await authenticatedFetch("/api/steam/link-url");
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || "Failed to get Steam link URL");
  }
  return res.json();
}

export async function apiGetSteamStatus(): Promise<{ steam_id: string | null; hide_game: boolean }> {
  const res = await authenticatedFetch("/api/steam/status");
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || "Failed to get Steam status");
  }
  return res.json();
}

export async function apiSetSteamHideGame(hide: boolean): Promise<void> {
  const res = await authenticatedFetch("/api/steam/hide-game", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hide }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || "Failed to update Steam game visibility");
  }
}

export async function apiUnlinkSteam(): Promise<void> {
  const res = await authenticatedFetch("/api/steam/unlink", { method: "DELETE" });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || "Failed to unlink Steam");
  }
}

// ─── Spotify ──────────────────────────────────────────────────────────────────

export async function apiGetSpotifyLinkUrl(): Promise<{ url: string }> {
  const res = await authenticatedFetch("/api/spotify/link-url");
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || "Spotify integration not configured");
  }
  return res.json();
}

export async function apiGetSpotifyStatus(): Promise<{ linked: boolean; hide: boolean }> {
  const res = await authenticatedFetch("/api/spotify/status");
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || "Failed to get Spotify status");
  }
  return res.json();
}

export async function apiSetSpotifyHide(hide: boolean): Promise<void> {
  const res = await authenticatedFetch("/api/spotify/hide", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hide }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || "Failed to update Spotify visibility");
  }
}

export async function apiUnlinkSpotify(): Promise<void> {
  const res = await authenticatedFetch("/api/spotify/unlink", { method: "DELETE" });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || "Failed to unlink Spotify");
  }
}
