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

async function apiRefreshToken(): Promise<boolean> {
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

export async function apiLogin(username: string, password: string) {
  let res: Response;
  try {
    res = await fetch("/_matrix/client/r0/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
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
  }>;
}

export async function apiRegister(username: string, password: string) {
  let res: Response;
  try {
    res = await fetch("/_matrix/client/r0/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
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
    access_token: string;
    refresh_token: string;
    user_id: string;
  }>;
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
  const res = await fetch("/api/rooms");
  if (!res.ok) throw new Error("Failed to load rooms");
  return res.json() as Promise<{
    rooms: RoomSummary[];
  }>;
}

// ─── Messages ───────────────────────────────────────────────────────────────

export async function apiGetMessages(roomId: string, limit = 50, before?: number) {
  let url = `/_matrix/client/r0/rooms/${roomId}/messages?limit=${limit}`;
  if (before !== undefined) url += `&before=${before}`;
  const res = await authenticatedFetch(url);
  if (!res.ok) throw new Error("Failed to load messages");
  return res.json() as Promise<{
    chunk: MatrixMessage[];
    start: number;
    end: number;
    has_more: boolean;
  }>;
}

export async function apiSendMessage(roomId: string, body: string, inReplyTo?: string) {
  const txnId = Date.now();
  const payload: Record<string, string> = { msgtype: "m.text", body };
  if (inReplyTo) {
    payload.in_reply_to = inReplyTo;
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

// ─── Search ──────────────────────────────────────────────────────────────────

export async function apiSearchMessages(
  roomId: string,
  query: string,
  filter: string = "all"
): Promise<MatrixMessage[]> {
  const params = new URLSearchParams({ q: query, filter });
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
  content: {
    body: string;
    msgtype: string;
    in_reply_to?: string;
    reply_to_sender?: string;
    reply_to_body?: string;
  };
  redacted?: boolean;
  edited?: boolean;
  edited_at?: number;
  reactions?: Record<string, string[]>;
}

export interface VoiceMember {
  user_id: string;
  muted: boolean;
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
  owner_name_color?: string;
  mod_name_color?: string;
  unlisted?: boolean;
  has_password?: boolean;
  room_type?: string;
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

export async function apiUploadFile(
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
        // Try refresh and retry
        apiRefreshToken().then((refreshed) => {
          if (!refreshed) {
            reject(new Error("Upload failed - authentication expired"));
            return;
          }
          // Retry upload with new token
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

// ─── Link previews ──────────────────────────────────────────────────────────

export interface LinkPreview {
  title?: string;
  description?: string;
  image?: string;
  site_name?: string;
}

export async function apiGetLinkPreview(url: string): Promise<LinkPreview> {
  const res = await authenticatedFetch(`/api/link-preview?url=${encodeURIComponent(url)}`);
  if (!res.ok) throw new Error("Failed to fetch link preview");
  return res.json() as Promise<LinkPreview>;
}

export async function apiUpdateRoomSettings(
  roomId: string,
  settings: { name?: string; icon_url?: string; tags?: string[]; custom_emojis?: string[]; unlisted?: boolean; password?: string; remove_password?: boolean }
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
