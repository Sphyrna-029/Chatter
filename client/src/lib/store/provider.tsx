import {
  useReducer,
  useCallback,
  useMemo,
  useRef,
  useEffect,
  type ReactNode,
} from "react";
import { useVersionCheck } from "@/hooks/useVersionCheck";
import { displayUserId } from "@/lib/utils";
import { settingsKey, type NotificationLevel, type NotificationSettings } from "@/lib/notifications";
import {
  setAccessToken,
  setRefreshToken,
  clearTokens,
  getAccessToken,
  apiRefreshToken,
  setIsAdmin,
  getIsAdmin,
  setTotpVerified,
  getTotpVerified,
  apiLogin,
  apiRegister,
  apiLogout,
  apiDeleteAccount,
  apiGetJoinedRooms,
  apiGetUnreads,
  apiMarkRead,
  apiGetNotificationSettings,
  apiGetContinuity,
  apiSetDraft,
  apiSetResumePoint,
  apiSetNotificationLevel,
  apiSync,
  apiCreateRoom,
  apiJoinRoom,
  apiLeaveRoom,
  apiGetMessages,
  apiSearchMessages,
  apiGetRoomThreads,
  apiSendMessage,
  apiDeleteMessage,
  apiHardDeleteNotification,
  apiEditMessage,
  apiAddReaction,
  apiGetPins,
  apiGetMyPermissions,
  apiPinMessage,
  apiUnpinMessage,
  apiGetVoiceMembers,
  apiGetPresence,
  apiGetAllRooms,
  apiCreateDM,
  apiAddToDM,
  apiUpdateTopic,
  apiUpdateRoomSettings,
  apiKickMember,
  apiBanMember,
  apiUnbanMember,
  apiSetMemberRole,
  apiSetNameColors,
  apiGetRoomGroups,
  apiCreateRoomGroup,
  apiDeleteRoomGroup,
  apiUpdateRoomGroup,
  apiSetGroupRooms,
  apiSetGroupCollapsed,
  apiGetFriends,
  apiSendFriendRequest,
  apiAcceptFriendRequest,
  apiRejectFriendRequest,
  apiRemoveFriend,
  apiBlockUser,
  apiUnblockUser,
  apiGetServerInfo,
  apiGetThreadMessages,
  apiSendThreadMessage,
  apiSetThreadName,
  apiDeleteThread,
  apiGetChannels,
  apiCreateChannel,
  apiUpdateChannel,
  apiDeleteChannel,
  apiCreateCategory,
  apiUpdateCategory,
  apiDeleteCategory,
  apiGetRoles,
  apiCreateRole,
  apiUpdateRole,
  apiDeleteRole,
  apiGetAllMemberRoles,
  apiAssignMemberRoles,
  type RoomInfo,
} from "../api";
import { fetchIceServers } from "../webrtc";
import { AppActionsContext, AppStateContext, type AppActions } from "./context";
import { initialState, resumePointsMap } from "./types";
import { reducer } from "./reducer";
import { createWsMessageHandler } from "./wsHandler";



export function AppProvider({ children }: { children: ReactNode }) {
  useVersionCheck();
  const [state, dispatch] = useReducer(reducer, initialState);
  const wsRef = useRef<WebSocket | null>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingTimeoutsRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep a ref to latest state for WS handler closures
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Fetch public server settings on mount
  useEffect(() => {
    apiGetServerInfo().then((info) => {
      dispatch({ type: "SET_SERVER_SETTINGS", payload: { requireAuthForUploads: info.require_auth_for_uploads, uploadLimitBytes: info.upload_limit_bytes ?? 0, storageLimitBytes: info.storage_limit_bytes ?? 0 } });
    }).catch(() => {});
  }, []);

  // Reset search when switching rooms
  useEffect(() => {
    dispatch({ type: "CLOSE_SEARCH" });
  }, [state.currentRoomId]);

  // Debounced message-search execution (state lives in the store so the search
  // panel and the provider share one source of truth).
  useEffect(() => {
    const { open, query, filter, fileTypeFilter, thisChannel } = state.search;
    if (!open || !state.currentRoomId) return;

    let searchChannelId: string | undefined;
    let searchNoChannelOnly: boolean | undefined;
    if (thisChannel) {
      if (state.currentChannelId) {
        searchChannelId = state.currentChannelId;
      } else {
        searchNoChannelOnly = true;
      }
    }

    if (filter === "thread") {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
      searchTimerRef.current = setTimeout(async () => {
        dispatch({ type: "SET_SEARCH", payload: { loading: true } });
        try {
          const page = await apiGetRoomThreads(
            state.currentRoomId!,
            query.trim() || undefined,
            searchChannelId,
            searchNoChannelOnly
          );
          dispatch({
            type: "SET_SEARCH",
            payload: { results: page.items, hasMore: page.hasMore, nextOffset: page.nextOffset },
          });
        } catch {
          dispatch({ type: "SET_SEARCH", payload: { results: [], hasMore: false, nextOffset: 0 } });
        } finally {
          dispatch({ type: "SET_SEARCH", payload: { loading: false } });
        }
      }, 300);
      return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); };
    }

    if (filter !== "file" && !query.trim()) {
      dispatch({ type: "SET_SEARCH", payload: { results: [], hasMore: false, nextOffset: 0 } });
      return;
    }
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(async () => {
      dispatch({ type: "SET_SEARCH", payload: { loading: true } });
      try {
        const page = await apiSearchMessages(
          state.currentRoomId!,
          query.trim(),
          filter,
          fileTypeFilter,
          searchChannelId,
          searchNoChannelOnly
        );
        dispatch({
          type: "SET_SEARCH",
          payload: { results: page.items, hasMore: page.hasMore, nextOffset: page.nextOffset },
        });
      } catch {
        dispatch({ type: "SET_SEARCH", payload: { results: [], hasMore: false, nextOffset: 0 } });
      } finally {
        dispatch({ type: "SET_SEARCH", payload: { loading: false } });
      }
    }, 300);
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [state.search.open, state.search.query, state.search.filter, state.search.fileTypeFilter, state.search.thisChannel, state.currentRoomId, state.currentChannelId]);

  // Rehydrate session on mount via the HttpOnly refresh-token cookie.
  // No tokens are read from localStorage — the cookie is sent automatically
  // by the browser and is not accessible to JavaScript.
  useEffect(() => {
    const loginWithToken = (accessToken: string) => {
      try {
        const payload = JSON.parse(atob(accessToken.split(".")[1]));
        dispatch({
          type: "LOGIN",
          payload: { accessToken, userId: payload.sub },
        });
        dispatch({ type: "SET_IS_ADMIN", payload: getIsAdmin() });
        dispatch({ type: "SET_TOTP_VERIFIED", payload: getTotpVerified() });
        // Verify admin status with the server
        fetch("/api/admin/stats", {
          headers: { Authorization: `Bearer ${accessToken}` },
        }).then((res) => {
          const isAdmin = res.ok;
          setIsAdmin(isAdmin);
          dispatch({ type: "SET_IS_ADMIN", payload: isAdmin });
        }).catch(() => {});
        // Fetch ICE servers now that the token is available
        fetchIceServers();
      } catch {
        clearTokens();
      }
    };

    // Always try a cookie-based refresh on page load.
    // If the user has a valid session, the server will issue a fresh access token.
    apiRefreshToken().then((refreshed) => {
      if (refreshed) {
        const newToken = getAccessToken();
        if (newToken) loginWithToken(newToken);
      }
      // If refresh fails, the user is logged out — no further action needed.
    });
  }, []);

  // Keep a ref to loadRooms so WS handler can call it without stale closure
  const loadRoomsRef = useRef<() => Promise<void>>(() => Promise.resolve());

  const handleWsMessage = useCallback(
    createWsMessageHandler(dispatch, stateRef, typingTimeoutsRef, loadRoomsRef),
    []
  );

  // WebSocket connection — refreshes expired token before connecting
  const connectWebSocket = useCallback(async () => {
    let token = getAccessToken();
    if (!token) return;

    // Refresh the token if it has expired (access tokens live only 15 min)
    try {
      const payload = JSON.parse(atob(token.split(".")[1]));
      if (payload.exp * 1000 <= Date.now()) {
        const ok = await apiRefreshToken();
        if (!ok) {
          dispatch({ type: "LOGOUT" });
          return;
        }
        token = getAccessToken();
        if (!token) return;
      }
    } catch {
      // Malformed token — attempt connection anyway and let the server reject it
    }

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onopen = () => {
      // Use getAccessToken() in case another refresh happened between now and above
      const isMobileDevice = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
      ws.send(JSON.stringify({ access_token: getAccessToken() ?? token, is_mobile: isMobileDevice }));
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
  }, []); // getAccessToken / apiRefreshToken are module-level, no deps needed

  // Update document title with total unread notification count
  useEffect(() => {
    const total = Object.values(state.roomMentions).reduce((a, b) => a + b, 0);
    document.title = total > 0 ? `(${total}) Chatter` : "Chatter";
  }, [state.roomMentions]);

  // Connect WS when logged in
  useEffect(() => {
    if (state.accessToken && !wsRef.current && getAccessToken()) {
      connectWebSocket();
    }
    return () => {
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [state.accessToken]); // connectWebSocket is stable ([] deps), no need to include

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
        const mapped: Record<string, { status: string; customStatus?: string; avatarUrl?: string; about?: string; bannerUrl?: string; displayName?: string; nameFontUrl?: string; isMobile?: boolean; steamGame?: string; steamAppId?: string; gameSessionStart?: number; spotifyTrack?: string; spotifyArtist?: string; spotifyAlbumArt?: string }> = {};
        for (const [uid, p] of Object.entries(data.presence)) {
          const pAny = p as any;
          mapped[uid] = { status: pAny.status, customStatus: pAny.custom_status || undefined, avatarUrl: pAny.avatar_url || undefined, about: pAny.about || undefined, bannerUrl: pAny.banner_url || undefined, displayName: pAny.display_name || undefined, nameFontUrl: pAny.name_font_url || undefined, isMobile: pAny.is_mobile || false, steamGame: pAny.steam_game || undefined, steamAppId: pAny.steam_appid || undefined, gameSessionStart: pAny.game_session_start || undefined, spotifyTrack: pAny.spotify_track || undefined, spotifyArtist: pAny.spotify_artist || undefined, spotifyAlbumArt: pAny.spotify_album_art || undefined };
        }
        dispatch({ type: "SET_PRESENCE", payload: mapped });
      } catch {}
    }, 10000);
    return () => clearInterval(interval);
  }, [state.currentRoomId, state.accessToken]);

  // ─── Actions ───────────────────────────────────────────────────────────────

  const login = useCallback(async (username: string, password: string, totpCode?: string) => {
    const data = await apiLogin(username, password, totpCode);
    if (data.requires_totp) {
      return { requires_totp: true };
    }
    setAccessToken(data.access_token);
    setIsAdmin(!!data.is_admin);
    dispatch({
      type: "LOGIN",
      payload: { accessToken: data.access_token, userId: data.user_id },
    });
    dispatch({ type: "SET_IS_ADMIN", payload: !!data.is_admin });
    setTotpVerified(!!data.totp_verified);
    dispatch({ type: "SET_TOTP_VERIFIED", payload: !!data.totp_verified });
    return {};
  }, []);

  const register = useCallback(async (username: string, password: string, passwordConfirm: string, inviteCode?: string) => {
    const data = await apiRegister(username, password, passwordConfirm, inviteCode);
    // Don't store tokens - they aren't issued until TOTP verification
    return {
      user_id: data.user_id,
      totp_secret: data.totp_secret,
      totp_uri: data.totp_uri,
      totp_qr_base64: data.totp_qr_base64,
    };
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

  const deleteAccount = useCallback(async (totpCode: string) => {
    await apiDeleteAccount(totpCode);
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
        const emojiAliasesEvent = roomData.state.events.find(
          (e: any) => e.type === "m.room.emoji_aliases"
        );
        const nameColorsEvent = roomData.state.events.find(
          (e: any) => e.type === "m.room.name_colors"
        );
        const unlistedEvent = roomData.state.events.find(
          (e: any) => e.type === "m.room.unlisted"
        );
        const hasPasswordEvent = roomData.state.events.find(
          (e: any) => e.type === "m.room.has_password"
        );
        const roomTypeEvent = roomData.state.events.find(
          (e: any) => e.type === "m.room.type"
        );
        const readOnlyEvent = roomData.state.events.find(
          (e: any) => e.type === "m.room.read_only"
        );
        const bannerEvent = roomData.state.events.find(
          (e: any) => e.type === "m.room.banner"
        );
        const streakEvent = roomData.state.events.find(
          (e: any) => e.type === "m.room.dm_streak"
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
          emoji_aliases: emojiAliasesEvent?.content?.emoji_aliases || {},
          owner_name_color: nameColorsEvent?.content?.owner_name_color || "",
          mod_name_color: nameColorsEvent?.content?.mod_name_color || "",
          unlisted: unlistedEvent?.content?.unlisted || false,
          has_password: hasPasswordEvent?.content?.has_password || false,
          room_type: roomTypeEvent?.content?.room_type || "text",
          read_only: readOnlyEvent?.content?.read_only || false,
          banner_url: bannerEvent?.content?.banner_url || "",
          dm_streak_count: streakEvent?.content?.streak_count || 0,
          dm_streak_last_ts: streakEvent?.content?.last_message_ts || 0,
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

  // Unread counts are derived server-side from stored read markers, so they
  // survive a refresh; the reducer's own tallies only cover the live session.
  const loadUnreads = useCallback(async () => {
    try {
      const data = await apiGetUnreads();
      dispatch({ type: "SET_UNREADS", payload: data.unreads || [] });
    } catch {
      // Leave whatever the session has accumulated.
    }
  }, []);

  const markChannelRead = useCallback((roomId: string, channelId?: string) => {
    void apiMarkRead(roomId, channelId).catch(() => {});
  }, []);

  const moderateVoice = useCallback(
    (
      roomId: string,
      targetUserId: string,
      action: "mute" | "unmute" | "move" | "disconnect",
      targetChannelId?: string,
    ) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(
        JSON.stringify({
          type: "voice_moderate",
          room_id: roomId,
          target_user_id: targetUserId,
          action,
          ...(targetChannelId ? { target_channel_id: targetChannelId } : {}),
        }),
      );
    },
    [],
  );

  const loadNotificationSettings = useCallback(async () => {
    try {
      const data = await apiGetNotificationSettings();
      const map: NotificationSettings = {};
      for (const entry of data.settings || []) {
        map[settingsKey(entry.room_id, entry.channel_id)] = entry.level;
      }
      dispatch({ type: "SET_NOTIFICATION_SETTINGS", payload: map });
    } catch {
      // Fall back to the default level for everything.
    }
  }, []);

  const setNotificationLevel = useCallback(
    async (roomId: string, level: NotificationLevel | "default", channelId?: string) => {
      // Optimistic: the control should respond immediately, and a failed write
      // only costs the user a re-click.
      dispatch({
        type: "SET_NOTIFICATION_LEVEL",
        payload: { roomId, channelId: channelId ?? "", level },
      });
      await apiSetNotificationLevel(roomId, level, channelId);
    },
    [],
  );

  const loadContinuity = useCallback(async () => {
    try {
      const data = await apiGetContinuity();
      const drafts: Record<string, string> = {};
      for (const entry of data.drafts || []) {
        drafts[`${entry.room_id}|${entry.channel_id}`] = entry.text;
      }
      resumePointsMap.clear();
      for (const entry of data.resume || []) {
        resumePointsMap.set(entry.url, {
          positionSecs: entry.position_secs,
          durationSecs: entry.duration_secs,
        });
      }
      dispatch({ type: "SET_CONTINUITY", payload: { drafts } });
    } catch {
      // Nothing carried over; the composer just starts empty.
    }
  }, []);

  const saveDraft = useCallback(
    async (roomId: string, channelId: string, text: string) => {
      // Optimistic, and deliberately not awaited by the composer: typing must
      // never wait on a round trip.
      dispatch({ type: "SET_DRAFT", payload: { roomId, channelId, text } });
      try {
        await apiSetDraft(roomId, channelId, text);
      } catch {
        // The local draft still stands; it just will not reach another device.
      }
    },
    [],
  );

  const saveResumePoint = useCallback(
    async (url: string, positionSecs: number, durationSecs: number) => {
      resumePointsMap.set(url, { positionSecs, durationSecs });
      try {
        await apiSetResumePoint(url, positionSecs, durationSecs);
      } catch {
        // Playback is unaffected by a failed bookmark.
      }
    },
    [],
  );

  const selectRoom = useCallback(
    async (roomId: string) => {
      dispatch({ type: "SELECT_ROOM", payload: roomId });

      // Load channels for non-DM rooms and auto-select default text channel
      const roomInfo = stateRef.current.roomInfoMap[roomId];
      const isDm = roomInfo?.is_direct;
      let selectedChannelId: string | undefined;
      if (!isDm) {
        try {
          const channelsData = await apiGetChannels(roomId);
          dispatch({ type: "SET_CHANNELS", payload: channelsData.channels || [] });
          dispatch({ type: "SET_CHANNEL_CATEGORIES", payload: channelsData.categories || [] });
          const textChannels = (channelsData.channels || []).filter((c: any) => c.channel_type === "text");
          if (textChannels.length > 0) {
            selectedChannelId = textChannels[0].channel_id;
            dispatch({ type: "SELECT_CHANNEL", payload: selectedChannelId! });
          }
        } catch {
          dispatch({ type: "SET_CHANNELS", payload: [] });
        }

        // Load custom roles and member role assignments
        try {
          const [rolesData, memberRolesData] = await Promise.all([
            apiGetRoles(roomId),
            apiGetAllMemberRoles(roomId),
          ]);
          dispatch({ type: "SET_CUSTOM_ROLES", payload: rolesData.roles || [] });
          dispatch({ type: "SET_MEMBER_CUSTOM_ROLES", payload: memberRolesData.member_roles || {} });
        } catch {
          dispatch({ type: "SET_CUSTOM_ROLES", payload: [] });
          dispatch({ type: "SET_MEMBER_CUSTOM_ROLES", payload: {} });
        }

      }

      // Load voice channel members for non-DM rooms
      if (!isDm) {
        try {
          const voiceData = await apiGetVoiceMembers(roomId);
          if (voiceData.voice_channels) {
            const mapped: Record<string, { userId: string; muted: boolean; deafened: boolean; screen_sharing: boolean; force_muted?: boolean }[]> = {};
            for (const [chId, members] of Object.entries(voiceData.voice_channels)) {
              mapped[chId] = (members as any[]).map((m: any) => ({
                userId: m.user_id || m.userId,
                muted: m.muted,
                deafened: m.deafened ?? false,
                screen_sharing: m.screen_sharing,
                force_muted: m.force_muted ?? false,
              }));
            }
            // Only show voice members for the room being viewed — don't carry
            // over members from a different room's voice channels.
            dispatch({ type: "SET_VOICE_CHANNEL_MEMBERS", payload: mapped });
            dispatch({ type: "SET_VOICE_CHANNEL_OCCUPIED_SINCE", payload: (voiceData.occupied_since as Record<string, number>) || {} });
          } else {
            dispatch({ type: "SET_VOICE_CHANNEL_MEMBERS", payload: {} });
            dispatch({ type: "SET_VOICE_CHANNEL_OCCUPIED_SINCE", payload: {} });
          }
        } catch {}
      }

      // Load messages (with channel_id if available)
      const msgData = await apiGetMessages(roomId, 50, undefined, undefined, selectedChannelId);
      const messages = msgData.chunk.filter((m) => m.type === "m.room.message");
      dispatch({
        type: "SET_MESSAGES",
        payload: {
          messages,
          start: msgData.start,
          hasMore: msgData.has_more,
        },
      });
      // Populate reactions from loaded messages
      for (const msg of messages) {
        if (msg.reactions && Object.keys(msg.reactions).length > 0) {
          dispatch({
            type: "SET_REACTIONS",
            payload: { eventId: msg.event_id, reactions: msg.reactions },
          });
        }
      }
      // The server computes effective permissions; the client only mirrors them
      // to decide which controls to show.
      try {
        const permsData = await apiGetMyPermissions(roomId, selectedChannelId);
        dispatch({ type: "SET_MY_PERMISSIONS", payload: permsData.permissions });
      } catch {
        dispatch({ type: "SET_MY_PERMISSIONS", payload: null });
      }
      // Load pinned messages for the channel we landed on
      try {
        const page = await apiGetPins(roomId, selectedChannelId);
        dispatch({
          type: "SET_PINNED_MESSAGES",
          payload: { pins: page.items, hasMore: page.hasMore, nextOffset: page.nextOffset },
        });
      } catch {
        dispatch({
          type: "SET_PINNED_MESSAGES",
          payload: { pins: [], hasMore: false, nextOffset: 0 },
        });
      }
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
              e.content.displayname || displayUserId(e.state_key),
            role: e.content.role || "member",
            joinedAt: e.content.joined_at || undefined,
          })),
        });
      }
      // Load presence
      try {
        const presData = await apiGetPresence(roomId);
        const mapped: Record<string, { status: string; customStatus?: string; avatarUrl?: string; about?: string; bannerUrl?: string; nameFontUrl?: string; steamGame?: string; steamAppId?: string; gameSessionStart?: number; spotifyTrack?: string; spotifyArtist?: string; spotifyAlbumArt?: string }> = {};
        for (const [uid, p] of Object.entries(presData.presence)) {
          const pAny = p as any;
          mapped[uid] = { status: pAny.status, customStatus: pAny.custom_status || undefined, avatarUrl: pAny.avatar_url || undefined, about: pAny.about || undefined, bannerUrl: pAny.banner_url || undefined, nameFontUrl: pAny.name_font_url || undefined, steamGame: pAny.steam_game || undefined, steamAppId: pAny.steam_appid || undefined, gameSessionStart: pAny.game_session_start || undefined, spotifyTrack: pAny.spotify_track || undefined, spotifyArtist: pAny.spotify_artist || undefined, spotifyAlbumArt: pAny.spotify_album_art || undefined };
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
      const msgData = await apiGetMessages(cur.currentRoomId, 50, cur.oldestMessageIndex, undefined, cur.currentChannelId || undefined);
      const olderMessages = msgData.chunk.filter((m) => m.type === "m.room.message");
      dispatch({
        type: "PREPEND_MESSAGES",
        payload: {
          messages: olderMessages,
          start: msgData.start,
          hasMore: msgData.has_more,
        },
      });
      // Populate reactions from older messages
      for (const msg of olderMessages) {
        if (msg.reactions && Object.keys(msg.reactions).length > 0) {
          dispatch({
            type: "SET_REACTIONS",
            payload: { eventId: msg.event_id, reactions: msg.reactions },
          });
        }
      }
    } catch {
      dispatch({ type: "SET_LOADING_OLDER", payload: false });
    }
  }, []);

  const loadMessagesAround = useCallback(async (roomId: string, ts: number) => {
    const msgData = await apiGetMessages(roomId, 50, undefined, ts, stateRef.current.currentChannelId || undefined);
    const messages = msgData.chunk.filter((m) => m.type === "m.room.message");
    dispatch({
      type: "SET_MESSAGES",
      payload: {
        messages,
        start: msgData.start,
        hasMore: msgData.has_more,
      },
    });
    for (const msg of messages) {
      if (msg.reactions && Object.keys(msg.reactions).length > 0) {
        dispatch({
          type: "SET_REACTIONS",
          payload: { eventId: msg.event_id, reactions: msg.reactions },
        });
      }
    }
  }, []);

  const sendMessage = useCallback(
    async (body: string, inReplyTo?: string, spoiler?: boolean) => {
      if (!stateRef.current.currentRoomId) return;
      await apiSendMessage(stateRef.current.currentRoomId, body, inReplyTo, spoiler, stateRef.current.currentChannelId || undefined);
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

  const hardDeleteNotification = useCallback(
    async (roomId: string, eventId: string) => {
      await apiHardDeleteNotification(roomId, eventId);
      dispatch({ type: "REMOVE_MESSAGE", payload: eventId });
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

  // ─── Pinned messages ──────────────────────────────────────────────────
  const loadPins = useCallback(async () => {
    const cur = stateRef.current;
    if (!cur.currentRoomId) return;
    try {
      const page = await apiGetPins(cur.currentRoomId, cur.currentChannelId || undefined);
      dispatch({
        type: "SET_PINNED_MESSAGES",
        payload: { pins: page.items, hasMore: page.hasMore, nextOffset: page.nextOffset },
      });
    } catch {
      dispatch({
        type: "SET_PINNED_MESSAGES",
        payload: { pins: [], hasMore: false, nextOffset: 0 },
      });
    }
  }, []);

  const loadMorePins = useCallback(async () => {
    const cur = stateRef.current;
    if (!cur.currentRoomId || !cur.pinsHasMore || cur.loadingMorePins) return;
    dispatch({ type: "SET_LOADING_MORE_PINS", payload: true });
    try {
      const page = await apiGetPins(
        cur.currentRoomId,
        cur.currentChannelId || undefined,
        cur.pinsNextOffset,
      );
      dispatch({
        type: "APPEND_PINNED_MESSAGES",
        payload: { pins: page.items, hasMore: page.hasMore, nextOffset: page.nextOffset },
      });
    } catch {
      dispatch({ type: "SET_LOADING_MORE_PINS", payload: false });
    }
  }, []);

  const loadMoreSearchResults = useCallback(async () => {
    const cur = stateRef.current;
    const { open, query, filter, fileTypeFilter, thisChannel, hasMore, loadingMore, nextOffset } =
      cur.search;
    if (!open || !cur.currentRoomId || !hasMore || loadingMore) return;

    let searchChannelId: string | undefined;
    let searchNoChannelOnly: boolean | undefined;
    if (thisChannel) {
      if (cur.currentChannelId) {
        searchChannelId = cur.currentChannelId;
      } else {
        searchNoChannelOnly = true;
      }
    }

    dispatch({ type: "SET_SEARCH", payload: { loadingMore: true } });
    try {
      const page =
        filter === "thread"
          ? await apiGetRoomThreads(
              cur.currentRoomId,
              query.trim() || undefined,
              searchChannelId,
              searchNoChannelOnly,
              nextOffset,
            )
          : await apiSearchMessages(
              cur.currentRoomId,
              query.trim(),
              filter,
              fileTypeFilter,
              searchChannelId,
              searchNoChannelOnly,
              nextOffset,
            );
      dispatch({
        type: "APPEND_SEARCH_RESULTS",
        payload: { results: page.items, hasMore: page.hasMore, nextOffset: page.nextOffset },
      });
    } catch {
      dispatch({ type: "SET_SEARCH", payload: { loadingMore: false } });
    }
  }, []);

  const pinMessage = useCallback(async (eventId: string) => {
    const cur = stateRef.current;
    if (!cur.currentRoomId) return;
    // The server broadcasts m.room.pinned, which is what updates the list.
    await apiPinMessage(cur.currentRoomId, eventId);
  }, []);

  const unpinMessage = useCallback(async (eventId: string) => {
    const cur = stateRef.current;
    if (!cur.currentRoomId) return;
    await apiUnpinMessage(cur.currentRoomId, eventId);
  }, []);

  const openThread = useCallback(async (eventId: string) => {
    if (!stateRef.current.currentRoomId) return;
    const data = await apiGetThreadMessages(stateRef.current.currentRoomId, eventId);
    dispatch({
      type: "OPEN_THREAD",
      payload: { eventId, root: data.root, messages: data.messages },
    });
  }, []);

  const closeThread = useCallback(() => {
    dispatch({ type: "CLOSE_THREAD" });
  }, []);

  const sendThreadMessage = useCallback(async (body: string) => {
    const cur = stateRef.current;
    if (!cur.currentRoomId || !cur.activeThreadEventId) return;
    await apiSendThreadMessage(cur.currentRoomId, cur.activeThreadEventId, body);
  }, []);

  const setThreadName = useCallback(async (name: string) => {
    const cur = stateRef.current;
    if (!cur.currentRoomId || !cur.activeThreadEventId) return;
    await apiSetThreadName(cur.currentRoomId, cur.activeThreadEventId, name);
    dispatch({
      type: "SET_THREAD_NAME",
      payload: { eventId: cur.activeThreadEventId, name },
    });
  }, []);

  const deleteThread = useCallback(async () => {
    const cur = stateRef.current;
    if (!cur.currentRoomId || !cur.activeThreadEventId) return;
    await apiDeleteThread(cur.currentRoomId, cur.activeThreadEventId);
    dispatch({ type: "DELETE_THREAD", payload: cur.activeThreadEventId });
  }, []);

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
    async (name: string, topic: string, tags?: string[], iconUrl?: string, unlisted?: boolean, password?: string, roomType?: string) => {
      const data = await apiCreateRoom(name, topic, tags, iconUrl, unlisted, password, roomType);
      await loadRooms();
      await selectRoom(data.room_id);
    },
    [loadRooms, selectRoom]
  );

  const joinRoom = useCallback(
    async (roomId: string, password?: string) => {
      await apiJoinRoom(roomId, password);
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
      // Also load per-channel voice members
      if (voiceData.voice_channels) {
        const mapped: Record<string, { userId: string; muted: boolean; deafened: boolean; screen_sharing: boolean; force_muted?: boolean }[]> = {};
        for (const [chId, members] of Object.entries(voiceData.voice_channels)) {
          mapped[chId] = (members as any[]).map((m: any) => ({
            userId: m.user_id || m.userId,
            muted: m.muted,
            deafened: m.deafened ?? false,
            screen_sharing: m.screen_sharing,
            force_muted: m.force_muted ?? false,
          }));
        }
        dispatch({ type: "SET_VOICE_CHANNEL_MEMBERS", payload: mapped });
        dispatch({ type: "SET_VOICE_CHANNEL_OCCUPIED_SINCE", payload: (voiceData.occupied_since as Record<string, number>) || {} });
      }
    } catch {}
  }, []);

  const selectChannel = useCallback(async (channelId: string) => {
    dispatch({ type: "SELECT_CHANNEL", payload: channelId });
    const cur = stateRef.current;
    if (!cur.currentRoomId) return;
    // Load messages for the new channel
    const msgData = await apiGetMessages(cur.currentRoomId, 50, undefined, undefined, channelId);
    const messages = msgData.chunk.filter((m) => m.type === "m.room.message");
    dispatch({
      type: "SET_MESSAGES",
      payload: {
        messages,
        start: msgData.start,
        hasMore: msgData.has_more,
      },
    });
    for (const msg of messages) {
      if (msg.reactions && Object.keys(msg.reactions).length > 0) {
        dispatch({
          type: "SET_REACTIONS",
          payload: { eventId: msg.event_id, reactions: msg.reactions },
        });
      }
    }
    // Overwrites make permissions channel-scoped, so they follow the channel.
    try {
      const permsData = await apiGetMyPermissions(cur.currentRoomId, channelId);
      dispatch({ type: "SET_MY_PERMISSIONS", payload: permsData.permissions });
    } catch {
      dispatch({ type: "SET_MY_PERMISSIONS", payload: null });
    }
    try {
      const page = await apiGetPins(cur.currentRoomId, channelId);
      dispatch({
        type: "SET_PINNED_MESSAGES",
        payload: { pins: page.items, hasMore: page.hasMore, nextOffset: page.nextOffset },
      });
    } catch {
      dispatch({
        type: "SET_PINNED_MESSAGES",
        payload: { pins: [], hasMore: false, nextOffset: 0 },
      });
    }
  }, []);

  const createChannel = useCallback(async (roomId: string, name: string, channelType: string, topic?: string, categoryId?: string) => {
    await apiCreateChannel(roomId, { name, channel_type: channelType, topic, category_id: categoryId });
  }, []);

  const updateChannel = useCallback(async (roomId: string, channelId: string, data: { name?: string; topic?: string; read_only?: boolean }) => {
    await apiUpdateChannel(roomId, channelId, data);
  }, []);

  const deleteChannel = useCallback(async (roomId: string, channelId: string) => {
    await apiDeleteChannel(roomId, channelId);
  }, []);

  // ─── Custom Roles ─────────────────────────────────────────────────────
  const loadRoles = useCallback(async () => {
    const roomId = stateRef.current.currentRoomId;
    if (!roomId) return;
    try {
      const [rolesData, memberRolesData] = await Promise.all([
        apiGetRoles(roomId),
        apiGetAllMemberRoles(roomId),
      ]);
      dispatch({ type: "SET_CUSTOM_ROLES", payload: rolesData.roles || [] });
      dispatch({ type: "SET_MEMBER_CUSTOM_ROLES", payload: memberRolesData.member_roles || {} });
    } catch {}
  }, [dispatch]);

  const createRole = useCallback(async (roomId: string, name: string, color?: string, permissions?: Partial<import("../api").RolePermissions>) => {
    await apiCreateRole(roomId, { name, color, permissions });
  }, []);

  const updateRole = useCallback(async (roomId: string, roleId: string, data: { name?: string; color?: string; position?: number; permissions?: Partial<import("../api").RolePermissions> }) => {
    await apiUpdateRole(roomId, roleId, data);
    dispatch({ type: "UPDATE_CUSTOM_ROLE", payload: { role_id: roleId, ...data } as any });
  }, [dispatch]);

  const deleteRole = useCallback(async (roomId: string, roleId: string) => {
    await apiDeleteRole(roomId, roleId);
  }, []);

  const assignMemberRoles = useCallback(async (roomId: string, userId: string, roleIds: string[]) => {
    await apiAssignMemberRoles(roomId, userId, roleIds);
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
          ...(stateRef.current.currentChannelId ? { channel_id: stateRef.current.currentChannelId } : {}),
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
    async (targetUserIds: string | string[]) => {
      const data = await apiCreateDM(targetUserIds);
      await loadRooms();
      await selectRoom(data.room_id);
    },
    [loadRooms, selectRoom]
  );

  const addToGroupDM = useCallback(
    async (roomId: string, userId: string) => {
      await apiAddToDM(roomId, userId);
    },
    []
  );

  const updateTopic = useCallback(
    async (roomId: string, topic: string) => {
      await apiUpdateTopic(roomId, topic);
    },
    []
  );

  const updateRoomSettings = useCallback(
    async (roomId: string, settings: { name?: string; icon_url?: string; tags?: string[]; custom_emojis?: string[]; emoji_aliases?: Record<string, string>; unlisted?: boolean; password?: string; remove_password?: boolean; read_only?: boolean }) => {
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

  const loadRoomGroups = useCallback(async () => {
    try {
      const groups = await apiGetRoomGroups();
      dispatch({ type: "SET_ROOM_GROUPS", payload: groups });
    } catch {}
  }, []);

  const createRoomGroup = useCallback(async (name: string) => {
    await apiCreateRoomGroup(name);
    await loadRoomGroups();
  }, [loadRoomGroups]);

  const deleteRoomGroup = useCallback(async (groupId: string) => {
    await apiDeleteRoomGroup(groupId);
    dispatch({ type: "REMOVE_ROOM_GROUP", payload: groupId });
  }, []);

  const renameRoomGroup = useCallback(async (groupId: string, name: string) => {
    await apiUpdateRoomGroup(groupId, { name });
    await loadRoomGroups();
  }, [loadRoomGroups]);

  const setGroupRooms = useCallback(async (groupId: string, roomIds: string[]) => {
    await apiSetGroupRooms(groupId, roomIds);
    await loadRoomGroups();
  }, [loadRoomGroups]);

  const toggleGroupCollapsed = useCallback(async (groupId: string, collapsed: boolean) => {
    dispatch({ type: "TOGGLE_GROUP_COLLAPSED", payload: { groupId, collapsed } });
    await apiSetGroupCollapsed(groupId, collapsed);
  }, []);

  const loadFriends = useCallback(async () => {
    try {
      const data = await apiGetFriends();
      dispatch({
        type: "SET_FRIENDS_DATA",
        payload: {
          friends: data.friends,
          incomingRequests: data.incoming_requests,
          outgoingRequests: data.outgoing_requests,
          blocked: data.blocked,
        },
      });
    } catch {}
  }, []);

  const sendFriendRequest = useCallback(async (userId: string) => {
    const result = await apiSendFriendRequest(userId);
    if (result.auto_accepted) {
      dispatch({ type: "ADD_FRIEND", payload: userId });
    } else {
      dispatch({ type: "ADD_OUTGOING_REQUEST", payload: { userId, requestId: "" } });
    }
  }, []);

  const acceptFriendRequest = useCallback(async (userId: string) => {
    await apiAcceptFriendRequest(userId);
    dispatch({ type: "REMOVE_INCOMING_REQUEST", payload: userId });
    dispatch({ type: "ADD_FRIEND", payload: userId });
  }, []);

  const rejectFriendRequest = useCallback(async (userId: string) => {
    await apiRejectFriendRequest(userId);
    dispatch({ type: "REMOVE_INCOMING_REQUEST", payload: userId });
  }, []);

  const removeFriend = useCallback(async (userId: string) => {
    await apiRemoveFriend(userId);
    dispatch({ type: "REMOVE_FRIEND", payload: userId });
  }, []);

  const blockUser = useCallback(async (userId: string) => {
    await apiBlockUser(userId);
    dispatch({ type: "REMOVE_FRIEND", payload: userId });
    dispatch({ type: "REMOVE_INCOMING_REQUEST", payload: userId });
    dispatch({ type: "REMOVE_OUTGOING_REQUEST", payload: userId });
    dispatch({ type: "ADD_BLOCKED_USER", payload: userId });
  }, []);

  const unblockUser = useCallback(async (userId: string) => {
    await apiUnblockUser(userId);
    dispatch({ type: "REMOVE_BLOCKED_USER", payload: userId });
  }, []);

  const updateProfile = useCallback((profile: { avatarUrl?: string; bannerUrl?: string; about?: string; customStatus?: string; displayName?: string; nameFontUrl?: string }) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      const payload: any = { type: "set_profile" };
      if (profile.avatarUrl !== undefined) payload.avatar_url = profile.avatarUrl;
      if (profile.bannerUrl !== undefined) payload.banner_url = profile.bannerUrl;
      if (profile.about !== undefined) payload.about = profile.about;
      if (profile.customStatus !== undefined) payload.custom_status = profile.customStatus;
      if (profile.displayName !== undefined) payload.display_name = profile.displayName;
      if (profile.nameFontUrl !== undefined) payload.name_font_url = profile.nameFontUrl;
      ws.send(JSON.stringify(payload));
    }
  }, []);

  // Stable across state changes so action-only consumers never re-render.
  const actions = useMemo<AppActions>(
    () => ({
      dispatch,
      wsRef,
      login,
      register,
      logout,
      deleteAccount,
      loadRooms,
      selectRoom,
      loadOlderMessages,
      loadMessagesAround,
      sendMessage,
      openThread,
      closeThread,
      sendThreadMessage,
      setThreadName,
      deleteThread,
      deleteMessage,
      hardDeleteNotification,
      editMessage,
      addReaction,
      loadPins,
      loadMorePins,
      loadMoreSearchResults,
      pinMessage,
      unpinMessage,
      createRoom,
      joinRoom,
      leaveRoom,
      loadVoiceMembers,
      sendTyping,
      getAllRooms,
      openDM,
      addToGroupDM,
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
      selectChannel,
      createChannel,
      updateChannel,
      deleteChannel,
      loadRoles,
      createRole,
      updateRole,
      deleteRole,
      assignMemberRoles,
      loadRoomGroups,
      createRoomGroup,
      deleteRoomGroup,
      renameRoomGroup,
      setGroupRooms,
      toggleGroupCollapsed,
      loadFriends,
      loadUnreads,
      markChannelRead,
      loadNotificationSettings,
      loadContinuity,
      saveDraft,
      saveResumePoint,
      setNotificationLevel,
      moderateVoice,
      sendFriendRequest,
      acceptFriendRequest,
      rejectFriendRequest,
      removeFriend,
      blockUser,
      unblockUser,
    }),
    [login, register, logout, deleteAccount, loadRooms, selectRoom, loadOlderMessages, loadMessagesAround, sendMessage, openThread, closeThread, sendThreadMessage, setThreadName, deleteThread, deleteMessage, hardDeleteNotification, editMessage, addReaction, loadPins, loadMorePins, loadMoreSearchResults, pinMessage, unpinMessage, createRoom, joinRoom, leaveRoom, loadVoiceMembers, sendTyping, getAllRooms, openDM, addToGroupDM, updateTopic, updateRoomSettings, setCustomStatus, setManualStatus, updateProfile, kickMember, banMember, unbanMember, setMemberRole, setNameColors, selectChannel, createChannel, updateChannel, deleteChannel, loadRoles, createRole, updateRole, deleteRole, assignMemberRoles, loadRoomGroups, createRoomGroup, deleteRoomGroup, renameRoomGroup, setGroupRooms, toggleGroupCollapsed, loadFriends, loadUnreads, markChannelRead, loadNotificationSettings, loadContinuity, saveDraft, saveResumePoint, setNotificationLevel, moderateVoice, sendFriendRequest, acceptFriendRequest, rejectFriendRequest, removeFriend, blockUser, unblockUser],
  );

  return (
    <AppActionsContext.Provider value={actions}>
      <AppStateContext.Provider value={state}>{children}</AppStateContext.Provider>
    </AppActionsContext.Provider>
  );
}
