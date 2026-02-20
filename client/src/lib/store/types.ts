import type { MatrixMessage, RoomInfo } from "../api";
import type { Dispatch } from "react";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AppState {
  // Auth
  accessToken: string | null;
  userId: string | null;
  // Rooms
  joinedRoomIds: string[];
  roomInfoMap: Record<string, RoomInfo>;
  currentRoomId: string | null;
  // Messages
  messages: MatrixMessage[];
  messageReactions: Record<string, Record<string, string[]>>;
  hasMoreMessages: boolean;
  oldestMessageIndex: number | null;
  loadingOlderMessages: boolean;
  // Members
  roomMembers: { userId: string; displayName: string }[];
  userPresence: Record<string, { status: string; customStatus?: string; avatarUrl?: string; about?: string }>;
  // Voice
  inVoiceChannel: boolean;
  isMuted: boolean;
  voiceInputMode: "open" | "ptt";
  voiceRoomId: string | null;
  voiceMembers: string[];
  voiceMemberStates: Record<
    string,
    { muted: boolean; screen_sharing: boolean }
  >;
  // Screen share
  isScreenSharing: boolean;
  activeScreenSharers: string[];
  screenViewerOpen: boolean;
  selectedScreenSharer: string | null;
  screenViewers: Record<string, string[]>;
  // UI
  roomMentions: Record<string, number>;
  currentView: "chat" | "voice";
  replyingTo: MatrixMessage | null;
  // Typing
  typingUsers: string[];
  // Connection
  wsConnected: boolean;
}

// Module-level shared map for screen share MediaStreams
// (MediaStream is not serializable so it can't live in React state)
export const screenStreamsMap = new Map<string, MediaStream>();

export type Action =
  | { type: "LOGIN"; payload: { accessToken: string; userId: string } }
  | { type: "LOGOUT" }
  | { type: "SET_ROOMS"; payload: { roomIds: string[]; roomInfoMap: Record<string, RoomInfo> } }
  | { type: "SELECT_ROOM"; payload: string | null }
  | { type: "SET_MESSAGES"; payload: { messages: MatrixMessage[]; start: number; hasMore: boolean } }
  | { type: "PREPEND_MESSAGES"; payload: { messages: MatrixMessage[]; start: number; hasMore: boolean } }
  | { type: "SET_LOADING_OLDER"; payload: boolean }
  | { type: "ADD_MESSAGE"; payload: MatrixMessage }
  | { type: "REDACT_MESSAGE"; payload: string }
  | { type: "EDIT_MESSAGE"; payload: { eventId: string; newBody: string } }
  | { type: "SET_REACTIONS"; payload: { eventId: string; reactions: Record<string, string[]> } }
  | { type: "SET_ROOM_MEMBERS"; payload: { userId: string; displayName: string }[] }
  | { type: "SET_PRESENCE"; payload: Record<string, { status: string; customStatus?: string; avatarUrl?: string; about?: string }> }
  | { type: "SET_VOICE_STATE"; payload: Partial<Pick<AppState, "inVoiceChannel" | "isMuted" | "voiceInputMode" | "voiceRoomId" | "isScreenSharing">> }
  | { type: "SET_VOICE_MEMBERS"; payload: { members: string[]; states: Record<string, { muted: boolean; screen_sharing: boolean }> } }
  | { type: "VOICE_USER_JOINED"; payload: string }
  | { type: "VOICE_USER_LEFT"; payload: string }
  | { type: "VOICE_USER_MUTED"; payload: { userId: string; muted: boolean } }
  | { type: "SCREEN_SHARE_STARTED"; payload: string }
  | { type: "SCREEN_SHARE_STOPPED"; payload: string }
  | { type: "SET_ACTIVE_SCREEN_SHARERS"; payload: string[] }
  | { type: "SET_SCREEN_VIEWER"; payload: { open?: boolean; sharer?: string | null } }
  | { type: "SET_SCREEN_VIEWERS"; payload: { sharerId: string; viewers: string[] } }
  | { type: "SET_VIEW"; payload: "chat" | "voice" }
  | { type: "SET_MENTION"; payload: { roomId: string; hasMention: boolean; increment?: boolean } }
  | { type: "SET_REPLYING_TO"; payload: MatrixMessage | null }
  | { type: "UPDATE_MEMBER_EVENT"; payload: null }
  | { type: "UPDATE_ROOM_TOPIC"; payload: { roomId: string; topic: string } }
  | { type: "UPDATE_ROOM_SETTINGS"; payload: { roomId: string; name?: string; icon_url?: string; tags?: string[]; custom_emojis?: string[] } }
  | { type: "SET_TYPING_USER"; payload: string }
  | { type: "CLEAR_TYPING_USER"; payload: string }
  | { type: "SET_WS_CONNECTED"; payload: boolean };

export const initialState: AppState = {
  accessToken: null,
  userId: null,
  joinedRoomIds: [],
  roomInfoMap: {},
  currentRoomId: null,
  messages: [],
  messageReactions: {},
  hasMoreMessages: false,
  oldestMessageIndex: null,
  loadingOlderMessages: false,
  roomMembers: [],
  userPresence: {},
  inVoiceChannel: false,
  isMuted: false,
  voiceInputMode: "open",
  voiceRoomId: null,
  voiceMembers: [],
  voiceMemberStates: {},
  isScreenSharing: false,
  activeScreenSharers: [],
  screenViewerOpen: false,
  selectedScreenSharer: null,
  screenViewers: {},
  roomMentions: {},
  currentView: "chat",
  replyingTo: null,
  typingUsers: [],
  wsConnected: false,
};

export interface AppContextValue {
  state: AppState;
  dispatch: Dispatch<Action>;
  wsRef: React.MutableRefObject<WebSocket | null>;
  // Actions
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  loadRooms: () => Promise<void>;
  selectRoom: (roomId: string) => Promise<void>;
  sendMessage: (body: string, inReplyTo?: string) => Promise<void>;
  deleteMessage: (eventId: string) => Promise<void>;
  editMessage: (eventId: string, newBody: string) => Promise<void>;
  addReaction: (eventId: string, emoji: string) => Promise<void>;
  createRoom: (name: string, topic: string, tags?: string[], iconUrl?: string) => Promise<void>;
  joinRoom: (roomId: string) => Promise<void>;
  leaveRoom: (roomId: string) => Promise<void>;
  loadVoiceMembers: () => Promise<void>;
  loadOlderMessages: () => Promise<void>;
  sendTyping: () => void;
  getAllRooms: () => Promise<import("../api").RoomSummary[]>;
  openDM: (targetUserId: string) => Promise<void>;
  updateTopic: (roomId: string, topic: string) => Promise<void>;
  updateRoomSettings: (roomId: string, settings: { name?: string; icon_url?: string; tags?: string[]; custom_emojis?: string[] }) => Promise<void>;
  setCustomStatus: (status: string) => void;
  setManualStatus: (status: string) => void;
  updateProfile: (profile: { avatarUrl?: string; about?: string; customStatus?: string }) => void;
}
