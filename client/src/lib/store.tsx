import {
  createContext,
  useContext,
  useReducer,
  useCallback,
  useRef,
  useEffect,
  type ReactNode,
  type Dispatch,
} from "react";
import {
  setAccessToken,
  apiLogin,
  apiRegister,
  apiLogout,
  apiGetJoinedRooms,
  apiSync,
  apiCreateRoom,
  apiJoinRoom,
  apiLeaveRoom,
  apiGetMessages,
  apiSendMessage,
  apiDeleteMessage,
  apiEditMessage,
  apiAddReaction,
  apiGetVoiceMembers,
  apiGetPresence,
  apiGetAllRooms,
  apiCreateDM,
  apiUpdateTopic,
  apiUpdateRoomSettings,
  type MatrixMessage,
  type VoiceMember,
  type RoomInfo,
} from "./api";

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
  // UI
  roomMentions: Record<string, boolean>;
  currentView: "chat" | "voice";
  replyingTo: MatrixMessage | null;
  // Typing
  typingUsers: string[];
}

// Module-level shared map for screen share MediaStreams
// (MediaStream is not serializable so it can't live in React state)
export const screenStreamsMap = new Map<string, MediaStream>();

type Action =
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
  | { type: "SET_VOICE_STATE"; payload: Partial<Pick<AppState, "inVoiceChannel" | "isMuted" | "voiceInputMode" | "isScreenSharing">> }
  | { type: "SET_VOICE_MEMBERS"; payload: { members: string[]; states: Record<string, { muted: boolean; screen_sharing: boolean }> } }
  | { type: "VOICE_USER_JOINED"; payload: string }
  | { type: "VOICE_USER_LEFT"; payload: string }
  | { type: "VOICE_USER_MUTED"; payload: { userId: string; muted: boolean } }
  | { type: "SCREEN_SHARE_STARTED"; payload: string }
  | { type: "SCREEN_SHARE_STOPPED"; payload: string }
  | { type: "SET_ACTIVE_SCREEN_SHARERS"; payload: string[] }
  | { type: "SET_SCREEN_VIEWER"; payload: { open?: boolean; sharer?: string | null } }
  | { type: "SET_VIEW"; payload: "chat" | "voice" }
  | { type: "SET_MENTION"; payload: { roomId: string; hasMention: boolean } }
  | { type: "SET_REPLYING_TO"; payload: MatrixMessage | null }
  | { type: "UPDATE_MEMBER_EVENT"; payload: null }
  | { type: "UPDATE_ROOM_TOPIC"; payload: { roomId: string; topic: string } }
  | { type: "UPDATE_ROOM_SETTINGS"; payload: { roomId: string; name?: string; icon_url?: string; tags?: string[] } }
  | { type: "SET_TYPING_USER"; payload: string }
  | { type: "CLEAR_TYPING_USER"; payload: string };

const initialState: AppState = {
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
  voiceMembers: [],
  voiceMemberStates: {},
  isScreenSharing: false,
  activeScreenSharers: [],
  screenViewerOpen: false,
  selectedScreenSharer: null,
  roomMentions: {},
  currentView: "chat",
  replyingTo: null,
  typingUsers: [],
};

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "LOGIN":
      return {
        ...state,
        accessToken: action.payload.accessToken,
        userId: action.payload.userId,
      };
    case "LOGOUT":
      return { ...initialState };
    case "SET_ROOMS":
      return {
        ...state,
        joinedRoomIds: action.payload.roomIds,
        roomInfoMap: action.payload.roomInfoMap,
      };
    case "SELECT_ROOM":
      return {
        ...state,
        currentRoomId: action.payload,
        messages: [],
        hasMoreMessages: false,
        oldestMessageIndex: null,
        loadingOlderMessages: false,
        roomMembers: [],
        voiceMembers: [],
        voiceMemberStates: {},
        activeScreenSharers: [],
        screenViewerOpen: false,
        selectedScreenSharer: null,
        typingUsers: [],
        roomMentions: action.payload
          ? { ...state.roomMentions, [action.payload]: false }
          : state.roomMentions,
      };
    case "SET_MESSAGES":
      return {
        ...state,
        messages: action.payload.messages,
        oldestMessageIndex: action.payload.start,
        hasMoreMessages: action.payload.hasMore,
      };
    case "PREPEND_MESSAGES":
      return {
        ...state,
        messages: [...action.payload.messages, ...state.messages],
        oldestMessageIndex: action.payload.start,
        hasMoreMessages: action.payload.hasMore,
        loadingOlderMessages: false,
      };
    case "SET_LOADING_OLDER":
      return { ...state, loadingOlderMessages: action.payload };
    case "ADD_MESSAGE":
      return { ...state, messages: [...state.messages, action.payload] };
    case "REDACT_MESSAGE":
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.event_id === action.payload
            ? { ...m, redacted: true, content: { ...m.content, body: "[deleted]" } }
            : m
        ),
      };
    case "EDIT_MESSAGE":
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.event_id === action.payload.eventId
            ? { ...m, edited: true, content: { ...m.content, body: action.payload.newBody } }
            : m
        ),
      };
    case "SET_REACTIONS":
      return {
        ...state,
        messageReactions: {
          ...state.messageReactions,
          [action.payload.eventId]: action.payload.reactions,
        },
      };
    case "SET_ROOM_MEMBERS":
      return { ...state, roomMembers: action.payload };
    case "SET_PRESENCE":
      return { ...state, userPresence: action.payload };
    case "SET_VOICE_STATE":
      return { ...state, ...action.payload };
    case "SET_VOICE_MEMBERS":
      return {
        ...state,
        voiceMembers: action.payload.members,
        voiceMemberStates: action.payload.states,
      };
    case "VOICE_USER_JOINED": {
      const newMembers = state.voiceMembers.includes(action.payload)
        ? state.voiceMembers
        : [...state.voiceMembers, action.payload];
      return {
        ...state,
        voiceMembers: newMembers,
        voiceMemberStates: {
          ...state.voiceMemberStates,
          [action.payload]: state.voiceMemberStates[action.payload] || {
            muted: false,
            screen_sharing: false,
          },
        },
      };
    }
    case "VOICE_USER_LEFT": {
      const { [action.payload]: _, ...remainingStates } = state.voiceMemberStates;
      return {
        ...state,
        voiceMembers: state.voiceMembers.filter((id) => id !== action.payload),
        voiceMemberStates: remainingStates,
        activeScreenSharers: state.activeScreenSharers.filter(
          (id) => id !== action.payload
        ),
      };
    }
    case "VOICE_USER_MUTED":
      return {
        ...state,
        voiceMemberStates: {
          ...state.voiceMemberStates,
          [action.payload.userId]: {
            ...(state.voiceMemberStates[action.payload.userId] || {
              muted: false,
              screen_sharing: false,
            }),
            muted: action.payload.muted,
          },
        },
      };
    case "SCREEN_SHARE_STARTED":
      return {
        ...state,
        activeScreenSharers: state.activeScreenSharers.includes(action.payload)
          ? state.activeScreenSharers
          : [...state.activeScreenSharers, action.payload],
        voiceMemberStates: {
          ...state.voiceMemberStates,
          [action.payload]: {
            ...(state.voiceMemberStates[action.payload] || {
              muted: false,
              screen_sharing: false,
            }),
            screen_sharing: true,
          },
        },
      };
    case "SCREEN_SHARE_STOPPED":
      return {
        ...state,
        activeScreenSharers: state.activeScreenSharers.filter(
          (id) => id !== action.payload
        ),
        voiceMemberStates: {
          ...state.voiceMemberStates,
          [action.payload]: {
            ...(state.voiceMemberStates[action.payload] || {
              muted: false,
              screen_sharing: false,
            }),
            screen_sharing: false,
          },
        },
      };
    case "SET_ACTIVE_SCREEN_SHARERS":
      return { ...state, activeScreenSharers: action.payload };
    case "SET_SCREEN_VIEWER":
      return {
        ...state,
        screenViewerOpen: action.payload.open ?? state.screenViewerOpen,
        selectedScreenSharer: action.payload.sharer !== undefined ? action.payload.sharer : state.selectedScreenSharer,
      };
    case "SET_VIEW":
      return { ...state, currentView: action.payload };
    case "SET_MENTION":
      return {
        ...state,
        roomMentions: {
          ...state.roomMentions,
          [action.payload.roomId]: action.payload.hasMention,
        },
      };
    case "SET_REPLYING_TO":
      return { ...state, replyingTo: action.payload };
    case "UPDATE_ROOM_TOPIC":
      return {
        ...state,
        roomInfoMap: {
          ...state.roomInfoMap,
          [action.payload.roomId]: {
            ...state.roomInfoMap[action.payload.roomId],
            topic: action.payload.topic,
          },
        },
      };
    case "UPDATE_ROOM_SETTINGS": {
      const existing = state.roomInfoMap[action.payload.roomId];
      if (!existing) return state;
      return {
        ...state,
        roomInfoMap: {
          ...state.roomInfoMap,
          [action.payload.roomId]: {
            ...existing,
            ...(action.payload.name !== undefined && { name: action.payload.name }),
            ...(action.payload.icon_url !== undefined && { icon_url: action.payload.icon_url }),
            ...(action.payload.tags !== undefined && { tags: action.payload.tags }),
          },
        },
      };
    }
    case "UPDATE_MEMBER_EVENT":
      return state; // Trigger re-render for member loading
    case "SET_TYPING_USER":
      return {
        ...state,
        typingUsers: state.typingUsers.includes(action.payload)
          ? state.typingUsers
          : [...state.typingUsers, action.payload],
      };
    case "CLEAR_TYPING_USER":
      return {
        ...state,
        typingUsers: state.typingUsers.filter((id) => id !== action.payload),
      };
    default:
      return state;
  }
}

// ─── Context ─────────────────────────────────────────────────────────────────

interface AppContextValue {
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
  getAllRooms: () => Promise<import("./api").RoomSummary[]>;
  openDM: (targetUserId: string) => Promise<void>;
  updateTopic: (roomId: string, topic: string) => Promise<void>;
  updateRoomSettings: (roomId: string, settings: { name?: string; icon_url?: string; tags?: string[] }) => Promise<void>;
  setCustomStatus: (status: string) => void;
  updateProfile: (profile: { avatarUrl?: string; about?: string; customStatus?: string }) => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function useAppContext() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useAppContext must be within AppProvider");
  return ctx;
}

// ─── Provider ────────────────────────────────────────────────────────────────

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const wsRef = useRef<WebSocket | null>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingTimeoutsRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // WebSocket connection
  const connectWebSocket = useCallback(() => {
    if (!state.accessToken) return;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ access_token: state.accessToken }));
    };

    ws.onmessage = async (event) => {
      if (event.data instanceof ArrayBuffer) return;
      const msg = JSON.parse(event.data);
      handleWsMessage(msg);
    };

    ws.onerror = () => {};
    ws.onclose = () => {
      wsRef.current = null;
      setTimeout(connectWebSocket, 3000);
    };
  }, [state.accessToken]);

  const handleWsMessage = useCallback(
    (msg: any) => {
      if (msg.type === "m.room.message") {
        if (msg.room_id === stateRef.current.currentRoomId) {
          dispatch({ type: "ADD_MESSAGE", payload: msg });
        }
        // Check for mentions
        const myUsername = stateRef.current.userId?.split(":")[0]?.substring(1);
        if (myUsername && msg.content?.body?.includes(`@${myUsername}`)) {
          if (msg.room_id !== stateRef.current.currentRoomId) {
            dispatch({
              type: "SET_MENTION",
              payload: { roomId: msg.room_id, hasMention: true },
            });
          }
        }
      } else if (msg.type === "m.room.member") {
        // Re-fetch members and presence for the current room
        const curRoom = stateRef.current.currentRoomId;
        if (curRoom) {
          (async () => {
            try {
              const syncData = await apiSync();
              const roomData = syncData.rooms?.join?.[curRoom];
              if (roomData) {
                const memberEvents = roomData.state.events.filter(
                  (e: any) => e.type === "m.room.member"
                );
                dispatch({
                  type: "SET_ROOM_MEMBERS",
                  payload: memberEvents.map((e: any) => ({
                    userId: e.state_key,
                    displayName:
                      e.content.displayname || e.state_key.split(":")[0].substring(1),
                  })),
                });
              }
              const presData = await apiGetPresence(curRoom);
              const mapped: Record<string, { status: string; customStatus?: string; avatarUrl?: string; about?: string }> = {};
              for (const [uid, p] of Object.entries(presData.presence)) {
                const pAny = p as any;
                mapped[uid] = { status: pAny.status, customStatus: pAny.custom_status || undefined, avatarUrl: pAny.avatar_url || undefined, about: pAny.about || undefined };
              }
              dispatch({ type: "SET_PRESENCE", payload: mapped });
            } catch {}
          })();
        }
        // Refresh room list (member counts may have changed)
        loadRoomsRef.current();
      } else if (msg.type === "m.room.redaction") {
        if (msg.room_id === stateRef.current.currentRoomId) {
          dispatch({ type: "REDACT_MESSAGE", payload: msg.redacts });
        }
      } else if (msg.type === "m.room.edit") {
        if (msg.room_id === stateRef.current.currentRoomId) {
          dispatch({
            type: "EDIT_MESSAGE",
            payload: { eventId: msg.edits, newBody: msg.new_body },
          });
        }
      } else if (msg.type === "m.reaction") {
        if (msg.room_id === stateRef.current.currentRoomId) {
          dispatch({
            type: "SET_REACTIONS",
            payload: { eventId: msg.event_id, reactions: msg.reactions },
          });
        }
      } else if (msg.type === "user_typing") {
        if (
          msg.room_id === stateRef.current.currentRoomId &&
          msg.user_id !== stateRef.current.userId
        ) {
          // Track typing user with 3s auto-expiry
          dispatch({ type: "SET_TYPING_USER", payload: msg.user_id });
          if (typingTimeoutsRef.current[msg.user_id]) {
            clearTimeout(typingTimeoutsRef.current[msg.user_id]);
          }
          typingTimeoutsRef.current[msg.user_id] = setTimeout(() => {
            dispatch({ type: "CLEAR_TYPING_USER", payload: msg.user_id });
            delete typingTimeoutsRef.current[msg.user_id];
          }, 3000);

          const existing = stateRef.current.userPresence[msg.user_id];
          dispatch({
            type: "SET_PRESENCE",
            payload: {
              ...stateRef.current.userPresence,
              [msg.user_id]: { status: "active", customStatus: existing?.customStatus, avatarUrl: existing?.avatarUrl, about: existing?.about },
            },
          });
        }
      } else if (msg.type === "voice_user_joined") {
        if (msg.room_id === stateRef.current.currentRoomId) {
          dispatch({ type: "VOICE_USER_JOINED", payload: msg.user_id });
          if (stateRef.current.inVoiceChannel || msg.user_id === stateRef.current.userId) {
            new Audio("/external/vc-join.wav").play().catch(() => {});
          }
        }
      } else if (msg.type === "voice_user_left") {
        if (msg.room_id === stateRef.current.currentRoomId) {
          dispatch({ type: "VOICE_USER_LEFT", payload: msg.user_id });
        }
      } else if (msg.type === "voice_user_muted") {
        if (msg.room_id === stateRef.current.currentRoomId) {
          dispatch({
            type: "VOICE_USER_MUTED",
            payload: { userId: msg.user_id, muted: msg.muted },
          });
        }
      } else if (msg.type === "screen_share_started") {
        if (msg.room_id === stateRef.current.currentRoomId) {
          dispatch({ type: "SCREEN_SHARE_STARTED", payload: msg.user_id });
        }
      } else if (msg.type === "screen_share_stopped") {
        if (msg.room_id === stateRef.current.currentRoomId) {
          dispatch({ type: "SCREEN_SHARE_STOPPED", payload: msg.user_id });
        }
      } else if (msg.type === "m.reply_notification") {
        if (msg.room_id !== stateRef.current.currentRoomId) {
          dispatch({
            type: "SET_MENTION",
            payload: { roomId: msg.room_id, hasMention: true },
          });
        }
      }
      else if (msg.type === "presence_update") {
        if (msg.user_id && msg.status) {
          const existing = stateRef.current.userPresence[msg.user_id];
          dispatch({
            type: "SET_PRESENCE",
            payload: {
              ...stateRef.current.userPresence,
              [msg.user_id]: {
                status: msg.status,
                customStatus: msg.custom_status !== undefined ? msg.custom_status : existing?.customStatus,
                avatarUrl: msg.avatar_url !== undefined ? (msg.avatar_url || undefined) : existing?.avatarUrl,
                about: msg.about !== undefined ? (msg.about || undefined) : existing?.about,
              },
            },
          });
        }
      }
      else if (msg.type === "m.room.settings") {
        dispatch({
          type: "UPDATE_ROOM_SETTINGS",
          payload: {
            roomId: msg.room_id,
            name: msg.content?.name,
            icon_url: msg.content?.icon_url,
            tags: msg.content?.tags,
          },
        });
      }
      else if (msg.type === "m.room.topic") {
        dispatch({
          type: "UPDATE_ROOM_TOPIC",
          payload: { roomId: msg.room_id, topic: msg.content?.topic || "" },
        });
      }
      else if (msg.type === "m.room.created") {
        // A new DM room was created — refresh rooms list so it appears instantly
        loadRoomsRef.current();
      }
      // WebRTC signaling messages are handled by the voice/screen hooks
      // by subscribing to raw WS messages via a custom event
      window.dispatchEvent(
        new CustomEvent("ws-message", { detail: msg })
      );
    },
    []
  );

  // Keep a ref to latest state for WS handler closures
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Keep a ref to loadRooms so WS handler can call it without stale closure
  const loadRoomsRef = useRef<() => Promise<void>>(() => Promise.resolve());

  // Connect WS when logged in
  useEffect(() => {
    if (state.accessToken && !wsRef.current) {
      connectWebSocket();
    }
    return () => {
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [state.accessToken, connectWebSocket]);

  // Send periodic heartbeats to keep presence active
  useEffect(() => {
    if (!state.accessToken) return;
    const interval = setInterval(() => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "heartbeat" }));
      }
    }, 60000);
    return () => clearInterval(interval);
  }, [state.accessToken]);

  // Presence polling
  useEffect(() => {
    if (!state.currentRoomId || !state.accessToken) return;
    const interval = setInterval(async () => {
      try {
        const data = await apiGetPresence(stateRef.current.currentRoomId!);
        const mapped: Record<string, { status: string; customStatus?: string; avatarUrl?: string; about?: string }> = {};
        for (const [uid, p] of Object.entries(data.presence)) {
          const pAny = p as any;
          mapped[uid] = { status: pAny.status, customStatus: pAny.custom_status || undefined, avatarUrl: pAny.avatar_url || undefined, about: pAny.about || undefined };
        }
        dispatch({ type: "SET_PRESENCE", payload: mapped });
      } catch {}
    }, 10000);
    return () => clearInterval(interval);
  }, [state.currentRoomId, state.accessToken]);

  // ─── Actions ───────────────────────────────────────────────────────────────

  const login = useCallback(async (username: string, password: string) => {
    const data = await apiLogin(username, password);
    setAccessToken(data.access_token);
    dispatch({
      type: "LOGIN",
      payload: { accessToken: data.access_token, userId: data.user_id },
    });
  }, []);

  const register = useCallback(async (username: string, password: string) => {
    const data = await apiRegister(username, password);
    setAccessToken(data.access_token);
    dispatch({
      type: "LOGIN",
      payload: { accessToken: data.access_token, userId: data.user_id },
    });
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiLogout();
    } catch {}
    setAccessToken(null);
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.close();
      wsRef.current = null;
    }
    dispatch({ type: "LOGOUT" });
  }, []);

  const loadRooms = useCallback(async () => {
    const data = await apiGetJoinedRooms();
    const syncData = await apiSync();
    const roomInfoMap: Record<string, RoomInfo> = {};
    for (const roomId of data.joined_rooms) {
      const roomData = syncData.rooms?.join?.[roomId];
      if (roomData) {
        const nameEvent = roomData.state.events.find(
          (e: any) => e.type === "m.room.name"
        );
        const topicEvent = roomData.state.events.find(
          (e: any) => e.type === "m.room.topic"
        );
        const directEvent = roomData.state.events.find(
          (e: any) => e.type === "m.room.direct"
        );
        const tagsEvent = roomData.state.events.find(
          (e: any) => e.type === "m.room.tags"
        );
        const iconEvent = roomData.state.events.find(
          (e: any) => e.type === "m.room.icon"
        );
        roomInfoMap[roomId] = {
          room_id: roomId,
          name: nameEvent?.content?.name || "Unnamed Room",
          topic: topicEvent?.content?.topic || "",
          is_direct: directEvent?.content?.is_direct || false,
          tags: tagsEvent?.content?.tags || [],
          icon_url: iconEvent?.content?.icon_url || "",
          creator: nameEvent?.sender || "",
        };
      } else {
        roomInfoMap[roomId] = {
          room_id: roomId,
          name: "Unnamed Room",
          topic: "",
        };
      }
    }
    dispatch({
      type: "SET_ROOMS",
      payload: { roomIds: data.joined_rooms, roomInfoMap },
    });
  }, []);
  loadRoomsRef.current = loadRooms;

  const selectRoom = useCallback(
    async (roomId: string) => {
      dispatch({ type: "SELECT_ROOM", payload: roomId });
      // Load messages
      const msgData = await apiGetMessages(roomId);
      dispatch({
        type: "SET_MESSAGES",
        payload: {
          messages: msgData.chunk.filter((m) => m.type === "m.room.message"),
          start: msgData.start,
          hasMore: msgData.has_more,
        },
      });
      // Load members
      const syncData = await apiSync();
      const roomData = syncData.rooms?.join?.[roomId];
      if (roomData) {
        const memberEvents = roomData.state.events.filter(
          (e: any) => e.type === "m.room.member"
        );
        dispatch({
          type: "SET_ROOM_MEMBERS",
          payload: memberEvents.map((e: any) => ({
            userId: e.state_key,
            displayName:
              e.content.displayname || e.state_key.split(":")[0].substring(1),
          })),
        });
      }
      // Load presence
      try {
        const presData = await apiGetPresence(roomId);
        const mapped: Record<string, { status: string; customStatus?: string; avatarUrl?: string; about?: string }> = {};
        for (const [uid, p] of Object.entries(presData.presence)) {
          const pAny = p as any;
          mapped[uid] = { status: pAny.status, customStatus: pAny.custom_status || undefined, avatarUrl: pAny.avatar_url || undefined, about: pAny.about || undefined };
        }
        dispatch({ type: "SET_PRESENCE", payload: mapped });
      } catch {}
      // Load voice members
      try {
        const voiceData = await apiGetVoiceMembers(roomId);
        const members = voiceData.voice_members.map((m) => m.user_id);
        const states: Record<string, { muted: boolean; screen_sharing: boolean }> = {};
        const sharers: string[] = [];
        voiceData.voice_members.forEach((m) => {
          states[m.user_id] = {
            muted: m.muted,
            screen_sharing: m.screen_sharing,
          };
          if (m.screen_sharing) sharers.push(m.user_id);
        });
        dispatch({
          type: "SET_VOICE_MEMBERS",
          payload: { members, states },
        });
        dispatch({
          type: "SET_ACTIVE_SCREEN_SHARERS",
          payload: sharers,
        });
      } catch {}
    },
    []
  );

  const loadOlderMessages = useCallback(async () => {
    const cur = stateRef.current;
    if (!cur.currentRoomId || cur.loadingOlderMessages || !cur.hasMoreMessages) return;
    if (cur.oldestMessageIndex === null || cur.oldestMessageIndex <= 0) return;
    dispatch({ type: "SET_LOADING_OLDER", payload: true });
    try {
      const msgData = await apiGetMessages(cur.currentRoomId, 50, cur.oldestMessageIndex);
      dispatch({
        type: "PREPEND_MESSAGES",
        payload: {
          messages: msgData.chunk.filter((m) => m.type === "m.room.message"),
          start: msgData.start,
          hasMore: msgData.has_more,
        },
      });
    } catch {
      dispatch({ type: "SET_LOADING_OLDER", payload: false });
    }
  }, []);

  const sendMessage = useCallback(
    async (body: string, inReplyTo?: string) => {
      if (!stateRef.current.currentRoomId) return;
      await apiSendMessage(stateRef.current.currentRoomId, body, inReplyTo);
    },
    []
  );

  const deleteMessage = useCallback(
    async (eventId: string) => {
      if (!stateRef.current.currentRoomId) return;
      await apiDeleteMessage(stateRef.current.currentRoomId, eventId);
    },
    []
  );

  const editMessage = useCallback(
    async (eventId: string, newBody: string) => {
      if (!stateRef.current.currentRoomId) return;
      await apiEditMessage(stateRef.current.currentRoomId, eventId, newBody);
    },
    []
  );

  const addReaction = useCallback(
    async (eventId: string, emoji: string) => {
      if (!stateRef.current.currentRoomId) return;
      await apiAddReaction(stateRef.current.currentRoomId, eventId, emoji);
    },
    []
  );

  const createRoom = useCallback(
    async (name: string, topic: string, tags?: string[], iconUrl?: string) => {
      const data = await apiCreateRoom(name, topic, tags, iconUrl);
      await loadRooms();
      await selectRoom(data.room_id);
    },
    [loadRooms, selectRoom]
  );

  const joinRoom = useCallback(
    async (roomId: string) => {
      await apiJoinRoom(roomId);
      await loadRooms();
      await selectRoom(roomId);
    },
    [loadRooms, selectRoom]
  );

  const leaveRoom = useCallback(
    async (roomId: string) => {
      await apiLeaveRoom(roomId);
      if (stateRef.current.currentRoomId === roomId) {
        dispatch({ type: "SELECT_ROOM", payload: null });
      }
      await loadRooms();
    },
    [loadRooms]
  );

  const loadVoiceMembers = useCallback(async () => {
    if (!stateRef.current.currentRoomId) return;
    try {
      const voiceData = await apiGetVoiceMembers(stateRef.current.currentRoomId);
      const members = voiceData.voice_members.map((m) => m.user_id);
      const states: Record<string, { muted: boolean; screen_sharing: boolean }> = {};
      const sharers: string[] = [];
      voiceData.voice_members.forEach((m) => {
        states[m.user_id] = {
          muted: m.muted,
          screen_sharing: m.screen_sharing,
        };
        if (m.screen_sharing) sharers.push(m.user_id);
      });
      dispatch({
        type: "SET_VOICE_MEMBERS",
        payload: { members, states },
      });
      dispatch({
        type: "SET_ACTIVE_SCREEN_SHARERS",
        payload: sharers,
      });
    } catch {}
  }, []);

  const sendTyping = useCallback(() => {
    if (!stateRef.current.currentRoomId) return;
    if (typingTimeoutRef.current) return;
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: "typing",
          room_id: stateRef.current.currentRoomId,
        })
      );
    }
    typingTimeoutRef.current = setTimeout(() => {
      typingTimeoutRef.current = null;
    }, 1000);
  }, []);

  const getAllRooms = useCallback(async () => {
    const data = await apiGetAllRooms();
    return data.rooms;
  }, []);

  const openDM = useCallback(
    async (targetUserId: string) => {
      const data = await apiCreateDM(targetUserId);
      await loadRooms();
      await selectRoom(data.room_id);
    },
    [loadRooms, selectRoom]
  );

  const updateTopic = useCallback(
    async (roomId: string, topic: string) => {
      await apiUpdateTopic(roomId, topic);
    },
    []
  );

  const updateRoomSettings = useCallback(
    async (roomId: string, settings: { name?: string; icon_url?: string; tags?: string[] }) => {
      await apiUpdateRoomSettings(roomId, settings);
    },
    []
  );

  const setCustomStatus = useCallback((status: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "set_custom_status", custom_status: status }));
    }
  }, []);

  const updateProfile = useCallback((profile: { avatarUrl?: string; about?: string; customStatus?: string }) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      const payload: any = { type: "set_profile" };
      if (profile.avatarUrl !== undefined) payload.avatar_url = profile.avatarUrl;
      if (profile.about !== undefined) payload.about = profile.about;
      if (profile.customStatus !== undefined) payload.custom_status = profile.customStatus;
      ws.send(JSON.stringify(payload));
    }
  }, []);

  return (
    <AppContext.Provider
      value={{
        state,
        dispatch,
        wsRef,
        login,
        register,
        logout,
        loadRooms,
        selectRoom,
        loadOlderMessages,
        sendMessage,
        deleteMessage,
        editMessage,
        addReaction,
        createRoom,
        joinRoom,
        leaveRoom,
        loadVoiceMembers,
        sendTyping,
        getAllRooms,
        openDM,
        updateTopic,
        updateRoomSettings,
        setCustomStatus,
        updateProfile,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}
