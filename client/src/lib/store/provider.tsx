import {
  createContext,
  useContext,
  useReducer,
  useCallback,
  useRef,
  useEffect,
  type ReactNode,
} from "react";
import {
  setAccessToken,
  setRefreshToken,
  restoreTokens,
  clearTokens,
  getAccessToken,
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
  apiKickMember,
  apiBanMember,
  apiUnbanMember,
  apiSetMemberRole,
  apiSetNameColors,
  type RoomInfo,
} from "../api";
import type { AppContextValue } from "./types";
import { initialState } from "./types";
import { reducer } from "./reducer";
import { createWsMessageHandler } from "./wsHandler";

const AppContext = createContext<AppContextValue | null>(null);

export function useAppContext() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useAppContext must be within AppProvider");
  return ctx;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const wsRef = useRef<WebSocket | null>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingTimeoutsRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // Keep a ref to latest state for WS handler closures
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Restore tokens from localStorage on mount
  useEffect(() => {
    restoreTokens();
    const token = getAccessToken();
    if (token) {
      try {
        const payload = JSON.parse(atob(token.split(".")[1]));
        if (payload.sub && payload.exp * 1000 > Date.now()) {
          dispatch({
            type: "LOGIN",
            payload: { accessToken: token, userId: payload.sub },
          });
        } else {
          clearTokens();
        }
      } catch {
        clearTokens();
      }
    }
  }, []);

  // Keep a ref to loadRooms so WS handler can call it without stale closure
  const loadRoomsRef = useRef<() => Promise<void>>(() => Promise.resolve());

  const handleWsMessage = useCallback(
    createWsMessageHandler(dispatch, stateRef, typingTimeoutsRef, loadRoomsRef),
    []
  );

  // WebSocket connection
  const connectWebSocket = useCallback(() => {
    if (!state.accessToken) return;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ access_token: state.accessToken }));
      dispatch({ type: "SET_WS_CONNECTED", payload: true });
    };

    ws.onmessage = async (event) => {
      if (event.data instanceof ArrayBuffer) return;
      const msg = JSON.parse(event.data);
      handleWsMessage(msg);
    };

    ws.onerror = () => {};
    ws.onclose = () => {
      wsRef.current = null;
      dispatch({ type: "SET_WS_CONNECTED", payload: false });
      setTimeout(connectWebSocket, 3000);
    };
  }, [state.accessToken]);

  // Update document title with total unread notification count
  useEffect(() => {
    const total = Object.values(state.roomMentions).reduce((a, b) => a + b, 0);
    document.title = total > 0 ? `(${total}) Chatter` : "Chatter";
  }, [state.roomMentions]);

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
        const mapped: Record<string, { status: string; customStatus?: string; avatarUrl?: string; about?: string; bannerUrl?: string }> = {};
        for (const [uid, p] of Object.entries(data.presence)) {
          const pAny = p as any;
          mapped[uid] = { status: pAny.status, customStatus: pAny.custom_status || undefined, avatarUrl: pAny.avatar_url || undefined, about: pAny.about || undefined, bannerUrl: pAny.banner_url || undefined };
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
    setRefreshToken(data.refresh_token);
    dispatch({
      type: "LOGIN",
      payload: { accessToken: data.access_token, userId: data.user_id },
    });
  }, []);

  const register = useCallback(async (username: string, password: string) => {
    const data = await apiRegister(username, password);
    setAccessToken(data.access_token);
    setRefreshToken(data.refresh_token);
    dispatch({
      type: "LOGIN",
      payload: { accessToken: data.access_token, userId: data.user_id },
    });
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiLogout();
    } catch {}
    clearTokens();
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
        const customEmojisEvent = roomData.state.events.find(
          (e: any) => e.type === "m.room.custom_emojis"
        );
        const nameColorsEvent = roomData.state.events.find(
          (e: any) => e.type === "m.room.name_colors"
        );
        roomInfoMap[roomId] = {
          room_id: roomId,
          name: nameEvent?.content?.name || "Unnamed Room",
          topic: topicEvent?.content?.topic || "",
          is_direct: directEvent?.content?.is_direct || false,
          tags: tagsEvent?.content?.tags || [],
          icon_url: iconEvent?.content?.icon_url || "",
          creator: nameEvent?.sender || "",
          custom_emojis: customEmojisEvent?.content?.custom_emojis || [],
          owner_name_color: nameColorsEvent?.content?.owner_name_color || "",
          mod_name_color: nameColorsEvent?.content?.mod_name_color || "",
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
            role: e.content.role || "member",
          })),
        });
      }
      // Load presence
      try {
        const presData = await apiGetPresence(roomId);
        const mapped: Record<string, { status: string; customStatus?: string; avatarUrl?: string; about?: string; bannerUrl?: string }> = {};
        for (const [uid, p] of Object.entries(presData.presence)) {
          const pAny = p as any;
          mapped[uid] = { status: pAny.status, customStatus: pAny.custom_status || undefined, avatarUrl: pAny.avatar_url || undefined, about: pAny.about || undefined, bannerUrl: pAny.banner_url || undefined };
        }
        dispatch({ type: "SET_PRESENCE", payload: mapped });
      } catch {}
      // Load voice members — skip if we're in a voice channel on a different room
      // to avoid overwriting preserved voice/screen state
      const inVoice = stateRef.current.inVoiceChannel;
      const voiceRoom = stateRef.current.voiceRoomId;
      if (!inVoice || roomId === voiceRoom) {
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
      }
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
      if (!stateRef.current.currentRoomId || !stateRef.current.userId) return;
      // Optimistic update: toggle locally before the server round-trip
      const current = stateRef.current.messageReactions[eventId] ?? {};
      const users = current[emoji] ?? [];
      const userId = stateRef.current.userId;
      let optimistic: Record<string, string[]>;
      if (users.includes(userId)) {
        const next = users.filter((u) => u !== userId);
        if (next.length === 0) {
          const { [emoji]: _removed, ...rest } = current;
          optimistic = rest;
        } else {
          optimistic = { ...current, [emoji]: next };
        }
      } else {
        optimistic = { ...current, [emoji]: [...users, userId] };
      }
      dispatch({ type: "SET_REACTIONS", payload: { eventId, reactions: optimistic } });
      // Fire-and-forget; server WS broadcast will confirm with authoritative state
      apiAddReaction(stateRef.current.currentRoomId, eventId, emoji).catch(() => {
        // On failure, revert to previous state
        dispatch({ type: "SET_REACTIONS", payload: { eventId, reactions: current } });
      });
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
    async (roomId: string, settings: { name?: string; icon_url?: string; tags?: string[]; custom_emojis?: string[] }) => {
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

  const setManualStatus = useCallback((status: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "set_status", status }));
    }
  }, []);

  const kickMember = useCallback(async (roomId: string, userId: string) => {
    await apiKickMember(roomId, userId);
  }, []);

  const banMember = useCallback(async (roomId: string, userId: string) => {
    await apiBanMember(roomId, userId);
  }, []);

  const unbanMember = useCallback(async (roomId: string, userId: string) => {
    await apiUnbanMember(roomId, userId);
  }, []);

  const setMemberRole = useCallback(async (roomId: string, userId: string, role: string) => {
    await apiSetMemberRole(roomId, userId, role);
  }, []);

  const setNameColors = useCallback(async (roomId: string, ownerColor?: string, modColor?: string) => {
    await apiSetNameColors(roomId, ownerColor, modColor);
  }, []);

  const updateProfile = useCallback((profile: { avatarUrl?: string; bannerUrl?: string; about?: string; customStatus?: string }) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      const payload: any = { type: "set_profile" };
      if (profile.avatarUrl !== undefined) payload.avatar_url = profile.avatarUrl;
      if (profile.bannerUrl !== undefined) payload.banner_url = profile.bannerUrl;
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
        setManualStatus,
        updateProfile,
        kickMember,
        banMember,
        unbanMember,
        setMemberRole,
        setNameColors,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}
