// HTTP API wrapper for the Matrix-compatible backend

let _accessToken: string | null = null;

export function setAccessToken(token: string | null) {
  _accessToken = token;
}

export function getAccessToken() {
  return _accessToken;
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

// Auth
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
    // Try to get server error message
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
  return res.json() as Promise<{ access_token: string; user_id: string }>;
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
  return res.json() as Promise<{ access_token: string; user_id: string }>;
}

export async function apiLogout() {
  await fetch("/_matrix/client/r0/logout", {
    method: "POST",
    headers: authHeaders(),
  });
}

// Rooms
export async function apiGetJoinedRooms() {
  const res = await fetch("/_matrix/client/r0/joined_rooms", {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error("Failed to load rooms");
  return res.json() as Promise<{ joined_rooms: string[] }>;
}

export async function apiSync() {
  const res = await fetch("/_matrix/client/r0/sync?timeout=0", {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error("Sync failed");
  return res.json();
}

export async function apiCreateRoom(name: string, topic: string) {
  const res = await fetch("/_matrix/client/r0/createRoom", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ name, topic }),
  });
  if (!res.ok) throw new Error("Failed to create room");
  return res.json() as Promise<{ room_id: string }>;
}

export async function apiJoinRoom(roomId: string) {
  const res = await fetch(`/_matrix/client/r0/rooms/${roomId}/join`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error("Failed to join room");
  return res.json();
}

export async function apiLeaveRoom(roomId: string) {
  const res = await fetch(`/_matrix/client/r0/rooms/${roomId}/leave`, {
    method: "POST",
    headers: authHeaders(),
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
}

export async function apiGetAllRooms() {
  const res = await fetch("/api/rooms");
  if (!res.ok) throw new Error("Failed to load rooms");
  return res.json() as Promise<{
    rooms: RoomSummary[];
  }>;
}

// Messages
export async function apiGetMessages(roomId: string, limit = 50) {
  const res = await fetch(
    `/_matrix/client/r0/rooms/${roomId}/messages?limit=${limit}`,
    { headers: authHeaders() }
  );
  if (!res.ok) throw new Error("Failed to load messages");
  return res.json() as Promise<{ chunk: MatrixMessage[] }>;
}

export async function apiSendMessage(roomId: string, body: string, inReplyTo?: string) {
  const txnId = Date.now();
  const payload: Record<string, string> = { msgtype: "m.text", body };
  if (inReplyTo) {
    payload.in_reply_to = inReplyTo;
  }
  const res = await fetch(
    `/_matrix/client/r0/rooms/${roomId}/send/m.room.message/${txnId}`,
    {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify(payload),
    }
  );
  if (!res.ok) throw new Error("Failed to send message");
  return res.json();
}

export async function apiDeleteMessage(roomId: string, eventId: string) {
  const txnId = Date.now();
  const res = await fetch(
    `/_matrix/client/r0/rooms/${roomId}/redact/${eventId}/${txnId}`,
    {
      method: "DELETE",
      headers: authHeaders(),
    }
  );
  if (!res.ok) throw new Error("Failed to delete message");
  return res.json();
}

export async function apiAddReaction(
  roomId: string,
  eventId: string,
  emoji: string
) {
  const res = await fetch(
    `/_matrix/client/r0/rooms/${roomId}/send/m.reaction/${eventId}`,
    {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify({ emoji }),
    }
  );
  if (!res.ok) throw new Error("Failed to add reaction");
  return res.json();
}

// Voice
export async function apiGetVoiceMembers(roomId: string) {
  const res = await fetch(`/api/rooms/${roomId}/voice`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error("Failed to load voice members");
  return res.json() as Promise<{
    voice_members: VoiceMember[];
  }>;
}

// Presence
export async function apiGetPresence(roomId: string) {
  const res = await fetch(`/api/rooms/${roomId}/presence`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error("Failed to load presence");
  return res.json() as Promise<{
    presence: Record<string, { status: string }>;
  }>;
}

// Types
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
}

export async function apiUpdateTopic(roomId: string, topic: string) {
  const res = await fetch(
    `/_matrix/client/r0/rooms/${roomId}/state/m.room.topic`,
    {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify({ topic }),
    }
  );
  if (!res.ok) throw new Error("Failed to update topic");
  return res.json();
}

export async function apiCreateDM(targetUserId: string) {
  const res = await fetch("/_matrix/client/r0/createRoom", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ is_direct: true, invite: [targetUserId] }),
  });
  if (!res.ok) throw new Error("Failed to create DM");
  return res.json() as Promise<{ room_id: string }>;
}
