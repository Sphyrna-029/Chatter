import type { MatrixMessage, RoomInfo, RoomGroup, Channel, ChannelCategory, CustomRole } from "../api";
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
  roomMembers: { userId: string; displayName: string; role: string; joinedAt?: number }[];
  userPresence: Record<string, { status: string; customStatus?: string; avatarUrl?: string; about?: string; bannerUrl?: string; displayName?: string; nameFontUrl?: string; isMobile?: boolean; steamGame?: string; steamAppId?: string; gameSessionStart?: number; spotifyTrack?: string; spotifyArtist?: string; spotifyAlbumArt?: string }>;
  // Channels
  channels: Channel[];
  channelCategories: ChannelCategory[];
  currentChannelId: string | null;
  // Voice channels: channel_id -> list of user_ids in that voice channel
  voiceChannelMembers: Record<string, { userId: string; muted: boolean; deafened: boolean; screen_sharing: boolean }[]>;
  voiceChannelId: string | null;
  // Voice
  inVoiceChannel: boolean;
  isMuted: boolean;
  isDeafened: boolean;
  voiceInputMode: "open" | "ptt";
  voiceRoomId: string | null;
  voiceChannelName: string | null;
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
  // Voice channel occupied-since timestamps (ms epoch), keyed by channel_id
  voiceChannelOccupiedSince: Record<string, number>;
  // UI
  roomMentions: Record<string, number>;
  roomUnreadCounts: Record<string, number>;
  channelUnreadCounts: Record<string, number>;
  channelMentions: Record<string, number>;
  currentView: "chat" | "voice";
  replyingTo: MatrixMessage | null;
  // Threads
  activeThreadEventId: string | null;
  threadRootMessage: MatrixMessage | null;
  threadMessages: MatrixMessage[];
  // Typing
  typingUsers: string[];
  // Connection
  wsConnected: boolean;
  // Admin
  isAdmin: boolean;
  adminDashboardOpen: boolean;
  // Server settings
  requireAuthForUploads: boolean;
  uploadLimitBytes: number; // max single file size; 0 = unlimited
  storageLimitBytes: number; // per-user total storage quota; 0 = unlimited
  // 2FA
  totpVerified: boolean;
  // Room Groups
  roomGroups: RoomGroup[];
  // Custom Roles
  customRoles: CustomRole[];
  memberCustomRoles: Record<string, string[]>; // user_id -> role_ids
  // Friends
  friends: string[];
  incomingFriendRequests: { userId: string; requestId: string }[];
  outgoingFriendRequests: { userId: string; requestId: string }[];
  blockedUsers: string[];
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
  | { type: "SET_ROOM_MEMBERS"; payload: { userId: string; displayName: string; role: string; joinedAt?: number }[] }
  | { type: "SET_PRESENCE"; payload: Record<string, { status: string; customStatus?: string; avatarUrl?: string; about?: string; bannerUrl?: string; displayName?: string; nameFontUrl?: string; isMobile?: boolean; steamGame?: string; steamAppId?: string; gameSessionStart?: number; spotifyTrack?: string; spotifyArtist?: string; spotifyAlbumArt?: string }> }
  | { type: "SET_VOICE_STATE"; payload: Partial<Pick<AppState, "inVoiceChannel" | "isMuted" | "isDeafened" | "voiceInputMode" | "voiceRoomId" | "isScreenSharing" | "voiceChannelId" | "voiceChannelName">> }
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
  | { type: "OPEN_THREAD"; payload: { eventId: string; root: MatrixMessage; messages: MatrixMessage[] } }
  | { type: "CLOSE_THREAD" }
  | { type: "ADD_THREAD_MESSAGE"; payload: MatrixMessage }
  | { type: "UPDATE_THREAD_REPLY_COUNT"; payload: { eventId: string; count: number } }
  | { type: "ADD_THREAD_PARTICIPANTS"; payload: { eventId: string; participants: string[] } }
  | { type: "SET_THREAD_NAME"; payload: { eventId: string; name: string } }
  | { type: "UPDATE_MEMBER_EVENT"; payload: null }
  | { type: "UPDATE_ROOM_TOPIC"; payload: { roomId: string; topic: string } }
  | { type: "UPDATE_ROOM_SETTINGS"; payload: { roomId: string; name?: string; icon_url?: string; tags?: string[]; custom_emojis?: string[]; emoji_aliases?: Record<string, string>; unlisted?: boolean; has_password?: boolean; read_only?: boolean; banner_url?: string } }
  | { type: "SET_TYPING_USER"; payload: string }
  | { type: "CLEAR_TYPING_USER"; payload: string }
  | { type: "SET_WS_CONNECTED"; payload: boolean }
  | { type: "UPDATE_MEMBER_ROLE"; payload: { userId: string; role: string } }
  | { type: "UPDATE_NAME_COLORS"; payload: { roomId: string; owner_name_color: string; mod_name_color: string } }
  | { type: "SET_IS_ADMIN"; payload: boolean }
  | { type: "SET_ADMIN_DASHBOARD_OPEN"; payload: boolean }
  | { type: "SET_SERVER_SETTINGS"; payload: { requireAuthForUploads: boolean; uploadLimitBytes: number; storageLimitBytes: number } }
  | { type: "SET_TOTP_VERIFIED"; payload: boolean }
  | { type: "SET_FRIENDS_DATA"; payload: { friends: string[]; incomingRequests: { userId: string; requestId: string }[]; outgoingRequests: { userId: string; requestId: string }[]; blocked: string[] } }
  | { type: "SET_ROOM_GROUPS"; payload: RoomGroup[] }
  | { type: "UPDATE_ROOM_GROUP"; payload: RoomGroup }
  | { type: "REMOVE_ROOM_GROUP"; payload: string }
  | { type: "TOGGLE_GROUP_COLLAPSED"; payload: { groupId: string; collapsed: boolean } }
  | { type: "ADD_FRIEND"; payload: string }
  | { type: "REMOVE_FRIEND"; payload: string }
  | { type: "ADD_INCOMING_REQUEST"; payload: { userId: string; requestId: string } }
  | { type: "REMOVE_INCOMING_REQUEST"; payload: string }
  | { type: "ADD_OUTGOING_REQUEST"; payload: { userId: string; requestId: string } }
  | { type: "REMOVE_OUTGOING_REQUEST"; payload: string }
  | { type: "ADD_BLOCKED_USER"; payload: string }
  | { type: "REMOVE_BLOCKED_USER"; payload: string }
  | { type: "SET_CUSTOM_ROLES"; payload: CustomRole[] }
  | { type: "ADD_CUSTOM_ROLE"; payload: CustomRole }
  | { type: "UPDATE_CUSTOM_ROLE"; payload: Partial<CustomRole> & { role_id: string } }
  | { type: "REMOVE_CUSTOM_ROLE"; payload: string }
  | { type: "SET_MEMBER_CUSTOM_ROLES"; payload: Record<string, string[]> }
  | { type: "UPDATE_MEMBER_CUSTOM_ROLES"; payload: { userId: string; roleIds: string[] } }
  | { type: "SET_CHANNELS"; payload: Channel[] }
  | { type: "SET_CHANNEL_CATEGORIES"; payload: ChannelCategory[] }
  | { type: "ADD_CHANNEL_CATEGORY"; payload: ChannelCategory }
  | { type: "UPDATE_CHANNEL_CATEGORY"; payload: Partial<ChannelCategory> & { category_id: string } }
  | { type: "REMOVE_CHANNEL_CATEGORY"; payload: string }
  | { type: "SELECT_CHANNEL"; payload: string | null }
  | { type: "ADD_CHANNEL"; payload: Channel }
  | { type: "UPDATE_CHANNEL"; payload: Partial<Channel> & { channel_id: string } }
  | { type: "REMOVE_CHANNEL"; payload: string }
  | { type: "SET_VOICE_CHANNEL_MEMBERS"; payload: Record<string, { userId: string; muted: boolean; deafened: boolean; screen_sharing: boolean }[]> }
  | { type: "SET_VOICE_CHANNEL"; payload: { channelId: string; members: { userId: string; muted: boolean; deafened: boolean; screen_sharing: boolean }[] } }
  | { type: "SET_VOICE_CHANNEL_OCCUPIED_SINCE"; payload: Record<string, number> }
  | { type: "UPDATE_VOICE_CHANNEL_OCCUPIED_SINCE"; payload: { channelId: string; since: number | null } }
  | { type: "SET_CHANNEL_MENTION"; payload: { channelId: string; hasMention: boolean } }
  | { type: "INCREMENT_CHANNEL_UNREAD"; payload: string }
  | { type: "CLEAR_CHANNEL_UNREAD"; payload: string }
  | { type: "UPDATE_DM_STREAK"; payload: { roomId: string; streakCount: number; lastMessageTs: number } }
  | { type: "INCREMENT_ROOM_UNREAD"; payload: string }
  | { type: "CLEAR_ROOM_UNREAD"; payload: string }
  | { type: "REMOVE_MESSAGE"; payload: string };

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
  channels: [],
  channelCategories: [],
  currentChannelId: null,
  voiceChannelMembers: {},
  voiceChannelId: null,
  inVoiceChannel: false,
  isMuted: false,
  isDeafened: false,
  voiceInputMode: "open",
  voiceRoomId: null,
  voiceChannelName: null,
  voiceMembers: [],
  voiceMemberStates: {},
  isScreenSharing: false,
  activeScreenSharers: [],
  screenViewerOpen: false,
  selectedScreenSharer: null,
  screenViewers: {},
  voiceChannelOccupiedSince: {},
  roomMentions: {},
  roomUnreadCounts: {},
  channelUnreadCounts: {},
  channelMentions: {},
  currentView: "chat",
  replyingTo: null,
  activeThreadEventId: null,
  threadRootMessage: null,
  threadMessages: [],
  typingUsers: [],
  wsConnected: false,
  isAdmin: false,
  adminDashboardOpen: false,
  requireAuthForUploads: false,
  uploadLimitBytes: 0,
  storageLimitBytes: 0,
  totpVerified: false,
  roomGroups: [],
  customRoles: [],
  memberCustomRoles: {},
  friends: [],
  incomingFriendRequests: [],
  outgoingFriendRequests: [],
  blockedUsers: [],
};

export interface AppContextValue {
  state: AppState;
  dispatch: Dispatch<Action>;
  wsRef: React.MutableRefObject<WebSocket | null>;
  // Actions
  login: (username: string, password: string, totpCode?: string) => Promise<{ requires_totp?: boolean }>;
  register: (username: string, password: string, passwordConfirm: string, inviteCode?: string) => Promise<{ user_id: string; totp_secret: string; totp_uri: string; totp_qr_base64: string }>;
  deleteAccount: (totpCode: string) => Promise<void>;
  logout: () => Promise<void>;
  loadRooms: () => Promise<void>;
  selectRoom: (roomId: string) => Promise<void>;
  sendMessage: (body: string, inReplyTo?: string, spoiler?: boolean) => Promise<void>;
  openThread: (eventId: string) => Promise<void>;
  closeThread: () => void;
  sendThreadMessage: (body: string) => Promise<void>;
  setThreadName: (name: string) => Promise<void>;
  deleteMessage: (eventId: string) => Promise<void>;
  editMessage: (eventId: string, newBody: string) => Promise<void>;
  addReaction: (eventId: string, emoji: string) => Promise<void>;
  createRoom: (name: string, topic: string, tags?: string[], iconUrl?: string, unlisted?: boolean, password?: string, roomType?: string) => Promise<void>;
  joinRoom: (roomId: string, password?: string) => Promise<void>;
  leaveRoom: (roomId: string) => Promise<void>;
  loadVoiceMembers: () => Promise<void>;
  loadOlderMessages: () => Promise<void>;
  loadMessagesAround: (roomId: string, ts: number) => Promise<void>;
  sendTyping: () => void;
  getAllRooms: () => Promise<import("../api").RoomSummary[]>;
  openDM: (targetUserId: string) => Promise<void>;
  updateTopic: (roomId: string, topic: string) => Promise<void>;
  updateRoomSettings: (roomId: string, settings: { name?: string; icon_url?: string; tags?: string[]; custom_emojis?: string[]; emoji_aliases?: Record<string, string>; unlisted?: boolean; password?: string; remove_password?: boolean }) => Promise<void>;
  setCustomStatus: (status: string) => void;
  setManualStatus: (status: string) => void;
  updateProfile: (profile: { avatarUrl?: string; bannerUrl?: string; about?: string; customStatus?: string; displayName?: string; nameFontUrl?: string }) => void;
  kickMember: (roomId: string, userId: string) => Promise<void>;
  banMember: (roomId: string, userId: string) => Promise<void>;
  unbanMember: (roomId: string, userId: string) => Promise<void>;
  setMemberRole: (roomId: string, userId: string, role: string) => Promise<void>;
  setNameColors: (roomId: string, ownerColor?: string, modColor?: string) => Promise<void>;
  // Channels
  selectChannel: (channelId: string) => Promise<void>;
  createChannel: (roomId: string, name: string, channelType: string, topic?: string, categoryId?: string) => Promise<void>;
  updateChannel: (roomId: string, channelId: string, data: { name?: string; topic?: string; read_only?: boolean }) => Promise<void>;
  deleteChannel: (roomId: string, channelId: string) => Promise<void>;
  // Custom Roles
  loadRoles: () => Promise<void>;
  createRole: (roomId: string, name: string, color?: string, permissions?: Partial<import("../api").RolePermissions>) => Promise<void>;
  updateRole: (roomId: string, roleId: string, data: { name?: string; color?: string; position?: number; permissions?: Partial<import("../api").RolePermissions> }) => Promise<void>;
  deleteRole: (roomId: string, roleId: string) => Promise<void>;
  assignMemberRoles: (roomId: string, userId: string, roleIds: string[]) => Promise<void>;
  // Room Groups
  loadRoomGroups: () => Promise<void>;
  createRoomGroup: (name: string) => Promise<void>;
  deleteRoomGroup: (groupId: string) => Promise<void>;
  renameRoomGroup: (groupId: string, name: string) => Promise<void>;
  setGroupRooms: (groupId: string, roomIds: string[]) => Promise<void>;
  toggleGroupCollapsed: (groupId: string, collapsed: boolean) => Promise<void>;
  // Friends
  loadFriends: () => Promise<void>;
  sendFriendRequest: (userId: string) => Promise<void>;
  acceptFriendRequest: (userId: string) => Promise<void>;
  rejectFriendRequest: (userId: string) => Promise<void>;
  removeFriend: (userId: string) => Promise<void>;
  blockUser: (userId: string) => Promise<void>;
  unblockUser: (userId: string) => Promise<void>;
  hardDeleteNotification: (roomId: string, eventId: string) => Promise<void>;
}
