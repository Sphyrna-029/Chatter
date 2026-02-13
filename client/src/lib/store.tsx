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
  apiAddReaction,
  apiGetVoiceMembers,
  apiGetPresence,
  apiGetAllRooms,
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
  // Members
  roomMembers: { userId: string; displayName: string }[];
  userPresence: Record<string, { status: string }>;
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
}

// Module-level shared map for screen share MediaStreams
// (MediaStream is not serializable so it can't live in React state)
export const screenStreamsMap = new Map<string, MediaStream>();

type Action =
  | { type: "LOGIN"; payload: { accessToken: string; userId: string } }
  | { type: "LOGOUT" }
  | { type: "SET_ROOMS"; payload: { roomIds: string[]; roomInfoMap: Record<string, RoomInfo> } }
  | { type: "SELECT_ROOM"; payload: string | null }
  | { type: "SET_MESSAGES"; payload: MatrixMessage[] }
  | { type: "ADD_MESSAGE"; payload: MatrixMessage }
  | { type: "REDACT_MESSAGE"; payload: string }
  | { type: "SET_REACTIONS"; payload: { eventId: string; reactions: Record<string, string[]> } }
  | { type: "SET_ROOM_MEMBERS"; payload: { userId: string; displayName: string }[] }
  | { type: "SET_PRESENCE"; payload: Record<string, { status: string }> }
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
  | { type: "UPDATE_MEMBER_EVENT"; payload: null };

const initialState: AppState = {
  accessToken: null,
  userId: null,
  joinedRoomIds: [],
  roomInfoMap: {},
  currentRoomId: null,
  messages: [],
  messageReactions: {},
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
        roomMembers: [],
        voiceMembers: [],
        voiceMemberStates: {},
        activeScreenSharers: [],
        screenViewerOpen: false,
        selectedScreenSharer: null,
        roomMentions: action.payload
          ? { ...state.roomMentions, [action.payload]: false }
          : state.roomMentions,
      };
    case "SET_MESSAGES":
      return { ...state, messages: action.payload };
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
    case "UPDATE_MEMBER_EVENT":
      return state; // Trigger re-render for member loading
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
  sendMessage: (body: string) => Promise<void>;
  deleteMessage: (eventId: string) => Promise<void>;
  addReaction: (eventId: string, emoji: string) => Promise<void>;
  createRoom: (name: string, topic: string) => Promise<void>;
  joinRoom: (roomId: string) => Promise<void>;
  leaveRoom: (roomId: string) => Promise<void>;
  loadVoiceMembers: () => Promise<void>;
  sendTyping: () => void;
  getAllRooms: () => Promise<{ room_id: string; name: string; member_count: number }[]>;
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
        dispatch({ type: "UPDATE_MEMBER_EVENT", payload: null });
      } else if (msg.type === "m.room.redaction") {
        if (msg.room_id === stateRef.current.currentRoomId) {
          dispatch({ type: "REDACT_MESSAGE", payload: msg.redacts });
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
          dispatch({
            type: "SET_PRESENCE",
            payload: {
              ...stateRef.current.userPresence,
              [msg.user_id]: { status: "active" },
            },
          });
        }
      } else if (msg.type === "voice_user_joined") {
        if (msg.room_id === stateRef.current.currentRoomId) {
          dispatch({ type: "VOICE_USER_JOINED", payload: msg.user_id });
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

  // Presence polling
  useEffect(() => {
    if (!state.currentRoomId || !state.accessToken) return;
    const interval = setInterval(async () => {
      try {
        const data = await apiGetPresence(stateRef.current.currentRoomId!);
        dispatch({ type: "SET_PRESENCE", payload: data.presence });
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
        roomInfoMap[roomId] = {
          room_id: roomId,
          name: nameEvent?.content?.name || "Unnamed Room",
          topic: topicEvent?.content?.topic || "",
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

  const selectRoom = useCallback(
    async (roomId: string) => {
      dispatch({ type: "SELECT_ROOM", payload: roomId });
      // Load messages
      const msgData = await apiGetMessages(roomId);
      dispatch({
        type: "SET_MESSAGES",
        payload: msgData.chunk.filter((m) => m.type === "m.room.message"),
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
        dispatch({ type: "SET_PRESENCE", payload: presData.presence });
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

  const sendMessage = useCallback(
    async (body: string) => {
      if (!stateRef.current.currentRoomId) return;
      await apiSendMessage(stateRef.current.currentRoomId, body);
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

  const addReaction = useCallback(
    async (eventId: string, emoji: string) => {
      if (!stateRef.current.currentRoomId) return;
      await apiAddReaction(stateRef.current.currentRoomId, eventId, emoji);
    },
    []
  );

  const createRoom = useCallback(
    async (name: string, topic: string) => {
      const data = await apiCreateRoom(name, topic);
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
        sendMessage,
        deleteMessage,
        addReaction,
        createRoom,
        joinRoom,
        leaveRoom,
        loadVoiceMembers,
        sendTyping,
        getAllRooms,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}
