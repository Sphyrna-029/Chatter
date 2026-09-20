import {
  useReducer,
  useCallback,
  useMemo,
  useRef,
  useEffect,
  type ReactNode,
} from "react";
import { decideResumeAction } from "@/lib/wsResume";
import { useVersionCheck } from "@/hooks/useVersionCheck";
import { displayUserId } from "@/lib/utils";
import { settingsKey, type NotificationLevel, type NotificationSettings } from "@/lib/notifications";
import {
  setAccessToken,
  setRefreshToken,
  clearTokens,
  getAccessToken,
  refreshSession,
  hadSession,
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
  apiGetMessagesAfter,
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
  apiListEvents,
  apiCreateEvent,
  apiUpdateEvent,
  apiDeleteEvent,
  apiSetRsvp,
  apiCreatePoll,
  apiVotePoll,
  apiGetPoll,
  apiClosePoll,
  type EventDraft,
  type PollDraft,
  type RsvpStatus,
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
  apiSetSidebarOrder,
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
  apiGetRoomMembers,
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
import { clearMediaBlobs } from "@/lib/mediaBlobs";
import { clearMessagePreviews } from "@/lib/messageLinks";
import { fetchIceServers } from "../webrtc";
import { AppActionsContext, AppStateContext, type AppActions } from "./context";
import {
  initialState,
  resumePointsMap,
  THREAD_ACTIVE_WINDOW_MS,
  THREAD_PREVIEW_LIMIT,
  type MessageTarget,
  type ThreadPreview,
  type VoiceChannelMember,
} from "./types";
import type { ProfileTheme } from "../profileTheme";
import { reducer } from "./reducer";
import { createWsMessageHandler } from "./wsHandler";



/** How long to wait before opening the socket again after it closed. */
const WS_RECONNECT_MS = 3000;

/** How often, at most, to report that someone is still at their machine.
 *
 * A ceiling on chatter rather than a schedule: the ping is skipped entirely
 * when there has been no input since the last one. The server's idle threshold
 * is measured in minutes, so reporting oftener than this would buy nothing. */
const ACTIVITY_PING_MS = 60_000;

/** How often presence is reconciled against the server when nothing prompted it.
 *
 *  Long, because it is a safety net rather than the mechanism: presence rides
 *  the socket, and the paths that can actually miss something — a closed
 *  socket, a room switch, a backgrounded tab — each re-fetch on their own.
 */
const PRESENCE_RECONCILE_MS = 5 * 60_000;

/** Retry schedule for restoring a session at page load when nothing answers.
 *
 * Backed off rather than hammered, and bounded: a server that has not come
 * back within a couple of minutes is not one to keep silently polling, and the
 * login screen already sitting there stays the way back in. */
const SESSION_RESTORE_BASE_MS = 1000;
const SESSION_RESTORE_MAX_MS = 30_000;
const SESSION_RESTORE_MAX_ATTEMPTS = 8;

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
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    const restoreSession = () => {
      void refreshSession().then((outcome) => {
        if (cancelled) return;
        if (outcome === "refreshed") {
          const newToken = getAccessToken();
          if (newToken) loginWithToken(newToken);
          dispatch({ type: "SET_SESSION_RESTORE", payload: "restored" });
          return;
        }
        // The server judged the cookie and there is no session behind it, so
        // the login screen is the right answer.
        if (outcome === "rejected") {
          dispatch({ type: "SET_SESSION_RESTORE", payload: "absent" });
          return;
        }
        // Nothing answered. Loading while the server is down or restarting is
        // not evidence of being logged out, and showing a login screen to
        // someone who still has a session is why refreshing the page "logs
        // them in" — it was only ever asking again at a better moment.
        attempt += 1;
        // Someone who has signed in on this browser is waiting behind the
        // reconnecting screen, so keep asking however long it takes; the delay
        // settles at SESSION_RESTORE_MAX_MS. A browser that has never held a
        // session has a login form to get on with, so that one gives up.
        if (!hadSession() && attempt > SESSION_RESTORE_MAX_ATTEMPTS) {
          dispatch({ type: "SET_SESSION_RESTORE", payload: "absent" });
          return;
        }
        dispatch({ type: "SET_SESSION_RESTORE", payload: "unreachable" });
        timer = setTimeout(
          restoreSession,
          Math.min(SESSION_RESTORE_BASE_MS * 2 ** (attempt - 1), SESSION_RESTORE_MAX_MS),
        );
      });
    };
    restoreSession();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  // Keep a ref to loadRooms so WS handler can call it without stale closure
  const loadRoomsRef = useRef<() => Promise<void>>(() => Promise.resolve());
  // Defined further down, but needed by the reconnect handler above it.
  const loadUnreadsRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const loadVoiceMembersRef = useRef<(roomId?: string) => Promise<void>>(() => Promise.resolve());
  const loadPresenceRef = useRef<(roomId?: string) => Promise<void>>(() => Promise.resolve());
  const loadActiveThreadsRef = useRef<(roomId: string) => Promise<void>>(() =>
    Promise.resolve(),
  );

  const handleWsMessage = useCallback(
    createWsMessageHandler(dispatch, stateRef, typingTimeoutsRef, loadRoomsRef, loadPresenceRef),
    []
  );

  /** False until the socket has connected once, so the first open is not
   *  mistaken for a reconnection. */
  const hasConnectedRef = useRef(false);
  // When the page was last backgrounded, so a resume can tell a glance away
  // from a phone that was put down.
  const hiddenAtRef = useRef<number | null>(null);

  /**
   * Replay whatever arrived while the socket was down.
   *
   * Live events are the only way a message reaches an open channel, so a
   * dropped connection silently leaves a hole in the timeline — the client
   * keeps rendering, the banner clears, and nothing says that anything is
   * missing. This closes the hole from the newest message actually held,
   * looping when the gap was wider than one page.
   *
   * Messages are replayed through ADD_MESSAGE, which ignores an event_id it
   * already has, so an overlap with what arrived live is harmless.
   */
  const recoverMissedMessages = useCallback(async () => {
    // Server-computed, so these are right even where the timeline is not.
    void loadUnreadsRef.current();
    // Who is in a call, who is muted, who is sharing — all of it is assembled
    // from events, and every event sent while the socket was down reached
    // nobody. Nothing else refetches it, so a single missed join left the call
    // looking wrong until the room was reselected. Ask the server outright.
    //
    // (The server pushes the same snapshot when the socket opens; this covers
    // the case where the connection survived and only the events were lost.)
    void loadVoiceMembersRef.current();
    // Online, idle and offline are broadcast the same way, and were missed the
    // same way. The poll would correct it within ten seconds, but only for the
    // room on screen and only once it next fires.
    void loadPresenceRef.current();

    const { currentRoomId, currentChannelId, messages } = stateRef.current;
    if (!currentRoomId) return;

    // With nothing loaded there is no gap to close — opening the channel will
    // fetch it. Only a timeline that already has a tail can have lost one.
    //
    // The cursor carries the event id as well as the timestamp: two messages
    // can share a millisecond, and asking only for "newer than this time"
    // would step straight over the second one.
    let cursor: { ts: number; eventId: string } | null = null;
    for (const message of messages) {
      if (
        !cursor ||
        message.origin_server_ts > cursor.ts ||
        (message.origin_server_ts === cursor.ts && message.event_id > cursor.eventId)
      ) {
        cursor = { ts: message.origin_server_ts, eventId: message.event_id };
      }
    }
    if (!cursor) return;

    try {
      // Bounded: a socket down for days should not walk the whole history.
      for (let page = 0; page < 20; page++) {
        const data = await apiGetMessagesAfter(
          currentRoomId,
          cursor.ts,
          currentChannelId ?? undefined,
          undefined,
          cursor.eventId,
        );
        const chunk = data.chunk || [];
        if (chunk.length === 0) return;
        for (const message of chunk) {
          dispatch({ type: "ADD_MESSAGE", payload: message });
        }
        // Continue from the last message of this page, in the server's order.
        const last = chunk[chunk.length - 1];
        cursor = { ts: last.origin_server_ts, eventId: last.event_id };
        if (!data.has_more) return;
      }
    } catch {
      // The socket is back and live messages are flowing again; the hole stays
      // until the channel is reopened, which is no worse than before.
    }
  }, []);

  // WebSocket connection — refreshes expired token before connecting
  const connectWebSocket = useCallback(async () => {
    let token = getAccessToken();
    if (!token) return;

    // Refresh the token if it has expired (access tokens live only 15 min)
    try {
      const payload = JSON.parse(atob(token.split(".")[1]));
      if (payload.exp * 1000 <= Date.now()) {
        const outcome = await refreshSession();
        if (outcome === "rejected") {
          dispatch({ type: "LOGOUT" });
          return;
        }
        if (outcome === "unreachable") {
          // The server is down, restarting, or behind a proxy answering for
          // it. That is exactly when this runs — the socket dropped for the
          // same reason — so it must not be read as the session ending. Keep
          // trying on the same cadence as the socket's own retry; returning
          // without one would strand the client until it was reloaded.
          setTimeout(connectWebSocket, WS_RECONNECT_MS);
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

      // Live events only exist while the socket does. Anything sent while it
      // was down reached nobody, so the first connection is a load and every
      // one after it is a repair.
      if (hasConnectedRef.current) {
        void recoverMissedMessages();
        // Viewer lists describe live subscriptions the server keeps only in
        // memory. Reconnecting may mean reconnecting to a restarted server
        // that has none, so drop ours and wait to be told again rather than
        // going on showing people who were watching a share that is over.
        dispatch({ type: "CLEAR_SCREEN_VIEWERS" });
      }
      hasConnectedRef.current = true;
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
      setTimeout(connectWebSocket, WS_RECONNECT_MS);
    };
  }, []); // getAccessToken / apiRefreshToken are module-level, no deps needed

  // Update document title with total unread notification count
  useEffect(() => {
    const total = Object.values(state.roomMentions).reduce((a, b) => a + b, 0);
    document.title = total > 0 ? `(${total}) Chatter` : "Chatter";
  }, [state.roomMentions]);

  // A backgrounded phone freezes the page: timers stop, and the socket the
  // server timed out is not necessarily reported closed on this side either.
  // Reconnection is driven entirely by onclose, so without this the page comes
  // back showing whoever was in a call when it was put down.
  useEffect(() => {
    if (!state.accessToken) return;
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        hiddenAtRef.current = Date.now();
        return;
      }
      const hiddenAt = hiddenAtRef.current;
      hiddenAtRef.current = null;

      const action = decideResumeAction({
        socketOpen: wsRef.current?.readyState === WebSocket.OPEN,
        hiddenForMs: hiddenAt === null ? 0 : Date.now() - hiddenAt,
      });
      if (action === "nothing") return;
      if (action === "resync") {
        void loadVoiceMembersRef.current();
        void loadPresenceRef.current();
        return;
      }
      // Drop whatever is left of the old socket without letting its onclose
      // schedule a second connection on top of this one.
      if (wsRef.current) {
        wsRef.current.onclose = null;
        try { wsRef.current.close(); } catch { /* already gone */ }
        wsRef.current = null;
      }
      void connectWebSocket();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [state.accessToken, connectWebSocket]);

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

  // Say goodbye when the page is really going away.
  //
  // Closing a tab or app without a close frame leaves the server waiting out
  // its 45s read timeout before anyone sees the session end — most of why a
  // phone kept showing as online after it was closed. `persisted` separates a
  // discard from a back/forward-cache suspend: an app merely switched away
  // keeps its session, and reconnects on its own if the socket dies meanwhile.
  useEffect(() => {
    const onPageHide = (e: PageTransitionEvent) => {
      if (e.persisted) return;
      const ws = wsRef.current;
      if (!ws) return;
      ws.onclose = null; // nothing to reconnect to; the page is leaving
      ws.close(1000, "page closed");
      wsRef.current = null;
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, []);

  // Tell the server its person is still there.
  //
  // This replaced an unconditional keepalive on the same cadence, which is what
  // made the idle status unreachable: the server refreshed `last_active` for
  // anything that arrived, so a tab left open overnight reported someone at
  // their desk. The socket's own ping/pong already proves the connection is
  // alive, so nothing is lost by only speaking up when there is something to
  // say.
  //
  // "Something to say" is real input since the last ping, and a visible tab. A
  // page left open in the background stops reporting and decays to idle on the
  // server's own clock, which is the behaviour anyone would expect of it.
  useEffect(() => {
    if (!state.accessToken) return;

    let interacted = true; // opening the app is itself an interaction
    const noteInteraction = () => {
      interacted = true;
    };
    const events: (keyof DocumentEventMap)[] = [
      "pointerdown",
      "keydown",
      "wheel",
      "touchstart",
    ];
    for (const event of events) {
      document.addEventListener(event, noteInteraction, { passive: true });
    }
    window.addEventListener("focus", noteInteraction);

    const interval = setInterval(() => {
      if (!interacted || document.visibilityState === "hidden") return;
      interacted = false;
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "activity" }));
      }
    }, ACTIVITY_PING_MS);

    return () => {
      clearInterval(interval);
      for (const event of events) {
        document.removeEventListener(event, noteInteraction);
      }
      window.removeEventListener("focus", noteInteraction);
    };
  }, [state.accessToken]);

  // Presence reconciliation.
  //
  // Not a poll. The server broadcasts every presence transition as it happens
  // — connecting, disconnecting, a manual or custom status, a profile edit,
  // going active — and announces the one that has no event of its own, going
  // idle, from a sweep a few seconds wide. So presence arrives over the socket,
  // and a fetch is only ever needed where the socket could not have told us:
  // when it was closed, and when the room on screen changed. The first is
  // handled on reconnect, the second by `selectRoom`.
  //
  // What is left is the tab coming back to the foreground, which is both a
  // catch-up and the reason this stopped being an interval: the old ten-second
  // poll had no visibility check at all, so a backgrounded phone asked for a
  // room's entire roster six times a minute for as long as the app stayed
  // open. The long timer below is a belt-and-braces net for a broadcast lost
  // to something we have not thought of, not the mechanism.
  useEffect(() => {
    if (!state.currentRoomId || !state.accessToken) return;

    const refreshIfVisible = () => {
      if (document.visibilityState === "hidden") return;
      void loadPresenceRef.current();
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") void loadPresenceRef.current();
    };
    document.addEventListener("visibilitychange", onVisibility);

    const interval = setInterval(refreshIfVisible, PRESENCE_RECONCILE_MS);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      clearInterval(interval);
    };
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
    // Media fetched with the session's credentials outlives the session
    // otherwise — the blob URLs are held by the cache, not by the tab — and
    // the next person to sign in here shares this document.
    clearMediaBlobs();
    // Likewise a resolved message link: what one account was allowed to read
    // is not what the next one is, and these were resolved against the
    // account that is leaving.
    clearMessagePreviews();
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
    clearMediaBlobs();
    clearMessagePreviews();
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
        const soundsEvent = roomData.state.events.find(
          (e: any) => e.type === "m.room.sounds"
        );
        const themeEvent = roomData.state.events.find(
          (e: any) => e.type === "m.room.theme"
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
          // Prefer the explicit list, fall back to the room's membership. The
          // member events have always been in this payload, so a DM resolves
          // its peer whatever the server is running — the explicit field only
          // saves the client from filtering.
          dm_user_ids:
            directEvent?.content?.dm_user_ids?.length
              ? directEvent.content.dm_user_ids
              : (roomData.state.events as { type?: string; state_key?: string }[])
                  .filter((e) => e.type === "m.room.member" && !!e.state_key)
                  .map((e) => e.state_key as string),
          dm_avatars: directEvent?.content?.dm_avatars || {},
          dm_voice_count: directEvent?.content?.dm_voice_count || 0,
          sounds: soundsEvent?.content?.sounds || {},
          // Rooms that predate the field, and any room whose state event is
          // missing, keep entrance sounds on — the field's default.
          entrance_sounds_enabled:
            soundsEvent?.content?.entrance_sounds_enabled !== false,
          suggested_theme: themeEvent?.content?.suggested_theme || "",
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
  loadUnreadsRef.current = loadUnreads;

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

  /**
   * The recently active threads a room's channel list previews.
   *
   * One request for the room rather than one per channel: the server already
   * sorts by activity, so grouping the answer is cheaper than asking N times.
   */
  const loadActiveThreads = useCallback(async (roomId: string) => {
    try {
      const data = await apiGetRoomThreads(
        roomId,
        undefined,
        undefined,
        false,
        0,
        // Enough to fill several channels' previews from one call.
        50,
        THREAD_ACTIVE_WINDOW_MS,
      );
      const grouped: Record<string, ThreadPreview[]> = {};
      for (const root of data.items || []) {
        const channelId = root.channel_id ?? "";
        const list = (grouped[channelId] ??= []);
        if (list.length >= THREAD_PREVIEW_LIMIT) continue;
        list.push({
          threadId: root.event_id,
          channelId,
          name: root.thread_name || root.content?.body || "Thread",
          replyCount: root.thread_reply_count ?? 0,
          lastActivityTs: root.thread_last_activity_ts ?? root.origin_server_ts,
        });
      }
      dispatch({ type: "SET_CHANNEL_THREADS", payload: grouped });
    } catch {
      // The channel list simply shows no threads.
    }
  }, []);
  loadActiveThreadsRef.current = loadActiveThreads;

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

  /** Open a room.
   *
   *  Six requests used to run here strictly one after another — channels, then
   *  roles, then messages, then permissions, then pins, then a full `/sync` for
   *  the member list — so the timeline waited on two calls it does not read,
   *  and the member list waited on all five. Only one dependency is real: the
   *  channel to land on comes out of the channel list, and messages, pins and
   *  permissions are all scoped to it. Everything else now runs alongside.
   */
  const selectRoom = useCallback(
    async (roomId: string) => {
      dispatch({ type: "SELECT_ROOM", payload: roomId });
      void loadActiveThreadsRef.current(roomId);

      // Whether this switch is still the one on screen. Requests that are no
      // longer awaited in order can land after the next switch has started, and
      // the roster or pins of the room someone just left must not paint over
      // the room they are now in.
      const stillCurrent = () => stateRef.current.currentRoomId === roomId;

      // Started first and never waited on: it depends on nothing else here.
      void apiGetRoomMembers(roomId)
        .then((data) => {
          if (!stillCurrent()) return;
          dispatch({
            type: "SET_ROOM_MEMBERS",
            payload: data.members.map((m) => ({
              userId: m.user_id,
              displayName: m.display_name || displayUserId(m.user_id),
              role: m.role || "member",
              joinedAt: m.joined_at || undefined,
            })),
          });
        })
        .catch(() => {});

      // Load channels for non-DM rooms and auto-select default text channel
      const roomInfo = stateRef.current.roomInfoMap[roomId];
      const isDm = roomInfo?.is_direct;
      let selectedChannelId: string | undefined;
      if (!isDm) {
        // Custom roles and their assignments decide which controls render, not
        // what the timeline contains, so they run alongside it.
        void Promise.all([apiGetRoles(roomId), apiGetAllMemberRoles(roomId)])
          .then(([rolesData, memberRolesData]) => {
            if (!stillCurrent()) return;
            dispatch({ type: "SET_CUSTOM_ROLES", payload: rolesData.roles || [] });
            dispatch({ type: "SET_MEMBER_CUSTOM_ROLES", payload: memberRolesData.member_roles || {} });
          })
          .catch(() => {
            if (!stillCurrent()) return;
            dispatch({ type: "SET_CUSTOM_ROLES", payload: [] });
            dispatch({ type: "SET_MEMBER_CUSTOM_ROLES", payload: {} });
          });

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

        // Fetched on the room switch rather than when the panel opens: the
        // header badge has to know about an event starting soon before anyone
        // thinks to look for one.
        void loadEventsRef.current(roomId);
      }

      // All three are scoped to the channel just landed on, so they go out
      // together. Only the messages are awaited, because they are what the
      // room is.
      //
      // The server computes effective permissions; the client only mirrors them
      // to decide which controls to show.
      void apiGetMyPermissions(roomId, selectedChannelId)
        .then((permsData) => {
          if (!stillCurrent()) return;
          dispatch({ type: "SET_MY_PERMISSIONS", payload: permsData.permissions });
        })
        .catch(() => {
          if (!stillCurrent()) return;
          dispatch({ type: "SET_MY_PERMISSIONS", payload: null });
        });
      void apiGetPins(roomId, selectedChannelId)
        .then((page) => {
          if (!stillCurrent()) return;
          dispatch({
            type: "SET_PINNED_MESSAGES",
            payload: { pins: page.items, hasMore: page.hasMore, nextOffset: page.nextOffset },
          });
        })
        .catch(() => {
          if (!stillCurrent()) return;
          dispatch({
            type: "SET_PINNED_MESSAGES",
            payload: { pins: [], hasMore: false, nextOffset: 0 },
          });
        });

      const msgData = await apiGetMessages(roomId, 50, undefined, undefined, selectedChannelId);
      const messages = msgData.chunk.filter((m) => m.type === "m.room.message");
      dispatch({
        type: "SET_MESSAGES",
        payload: {
          messages,
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
      // Load presence. The same call the poll makes, rather than a second copy
      // of the mapping that could drift from it — this one dropped `is_mobile`,
      // so opening a room took the phone badge off everyone in it until the
      // poll next ran.
      void loadPresenceRef.current(roomId);
      // Who is in this room's voice channels. Opening a room used to load the
      // flat member list and nothing per channel, so the channel list showed
      // empty voice channels however many people were sitting in them — and it
      // skipped the load entirely while a call was running in another room,
      // which is the case where the client is furthest behind. The snapshot
      // covers every room at once, so neither is a reason to ask for less.
      void loadVoiceMembersRef.current(roomId);
    },
    []
  );

  const loadOlderMessages = useCallback(async () => {
    const cur = stateRef.current;
    if (!cur.currentRoomId || cur.loadingOlderMessages || !cur.hasMoreMessages) return;
    // The cursor is the oldest message on screen, so nothing separate has to
    // be tracked — and it stays correct even if messages arrive meanwhile.
    const oldest = cur.messages[0];
    if (!oldest) return;
    dispatch({ type: "SET_LOADING_OLDER", payload: true });
    try {
      const msgData = await apiGetMessages(
        cur.currentRoomId,
        50,
        { ts: oldest.origin_server_ts, eventId: oldest.event_id },
        undefined,
        cur.currentChannelId || undefined,
      );
      const olderMessages = msgData.chunk.filter((m) => m.type === "m.room.message");
      dispatch({
        type: "PREPEND_MESSAGES",
        payload: {
          messages: olderMessages,
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

  /** Open a room on one of its messages.
   *
   *  The target is recorded before the room is selected and acted on in
   *  `ChatArea`, because the two halves cannot happen in one place: landing
   *  on a message needs the room's channels and timeline, which exist only
   *  once selecting the room has finished, and the caller is a row on another
   *  page that this very switch is about to unmount. */
  const openMessage = useCallback(
    async (target: MessageTarget) => {
      dispatch({ type: "SET_PENDING_JUMP", payload: target });
      // Already here: nothing to load, and `ChatArea` acts on the target as
      // soon as it sees it.
      if (stateRef.current.currentRoomId === target.roomId) return;
      await selectRoom(target.roomId);
    },
    [selectRoom],
  );

  const loadMessagesAround = useCallback(async (roomId: string, ts: number) => {
    const msgData = await apiGetMessages(roomId, 50, undefined, ts, stateRef.current.currentChannelId || undefined);
    const messages = msgData.chunk.filter((m) => m.type === "m.room.message");
    dispatch({
      type: "SET_MESSAGES",
      payload: {
        messages,
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
    async (eventId: string, deleteFiles?: boolean) => {
      if (!stateRef.current.currentRoomId) return;
      // Throws unless the server actually deleted it, so what follows only
      // runs on a success.
      await apiDeleteMessage(stateRef.current.currentRoomId, eventId, deleteFiles);
      // The broadcast tells the rest of the room, and it used to be the only
      // thing that told this client too — so the message stayed on the screen
      // of the person who had just deleted it until the socket came back with
      // the news. Applied here as well, against the success they already
      // waited for. The reducer removes by filtering, so the broadcast
      // arriving after this changes nothing.
      dispatch({ type: "REDACT_MESSAGE", payload: eventId });
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
  const loadEvents = useCallback(async (roomId?: string) => {
    const target = roomId ?? stateRef.current.currentRoomId;
    if (!target) return;
    try {
      const { events } = await apiListEvents(target);
      // A slow answer for a room the user has already left must not land.
      if (stateRef.current.currentRoomId !== target) return;
      dispatch({ type: "SET_ROOM_EVENTS", payload: events });
    } catch {
      if (stateRef.current.currentRoomId === target) {
        dispatch({ type: "SET_ROOM_EVENTS", payload: [] });
      }
    }
  }, []);
  const loadEventsRef = useRef(loadEvents);
  useEffect(() => { loadEventsRef.current = loadEvents; }, [loadEvents]);

  const createEvent = useCallback(async (draft: EventDraft) => {
    const roomId = stateRef.current.currentRoomId;
    if (!roomId) return;
    const { event } = await apiCreateEvent(roomId, draft);
    // The broadcast will arrive too, but it cannot carry this client's own
    // RSVP — and creating an event answers "going" for you.
    dispatch({ type: "UPSERT_ROOM_EVENT", payload: event });
  }, []);

  const updateEvent = useCallback(
    async (eventId: string, patch: Partial<EventDraft> & { cancelled?: boolean }) => {
      const roomId = stateRef.current.currentRoomId;
      if (!roomId) return;
      await apiUpdateEvent(roomId, eventId, patch);
    },
    [],
  );

  const deleteEvent = useCallback(async (eventId: string) => {
    const roomId = stateRef.current.currentRoomId;
    if (!roomId) return;
    await apiDeleteEvent(roomId, eventId);
    // Deleting is the one case the broadcast covers fully, but dropping it
    // here too means the card goes as the button is released.
    dispatch({ type: "REMOVE_ROOM_EVENT", payload: eventId });
  }, []);

  const setRsvp = useCallback(async (eventId: string, status: RsvpStatus | "") => {
    const roomId = stateRef.current.currentRoomId;
    if (!roomId) return;
    const previous = stateRef.current.roomEvents.find((e) => e.event_id === eventId)?.my_rsvp ?? "";
    dispatch({ type: "SET_MY_RSVP", payload: { eventId, status } });
    try {
      await apiSetRsvp(roomId, eventId, status);
    } catch (err) {
      dispatch({ type: "SET_MY_RSVP", payload: { eventId, status: previous } });
      throw err;
    }
  }, []);

  const createPoll = useCallback(async (draft: PollDraft) => {
    const roomId = stateRef.current.currentRoomId;
    if (!roomId) return;
    // The channel is read here rather than in the dialog: it is the one the
    // person is looking at, and a poll that quietly landed in the room's
    // default channel would be a poll asked of the wrong people.
    draft = { ...draft, channel_id: stateRef.current.currentChannelId ?? undefined };
    // The poll's own message arrives on the socket and carries its state, so
    // nothing is inserted here — this is the one path where the broadcast is
    // complete, because a poll nobody has voted in has no per-viewer half.
    await apiCreatePoll(roomId, draft);
  }, []);

  const votePoll = useCallback(async (pollId: string, options: number[]) => {
    const roomId = stateRef.current.currentRoomId;
    if (!roomId) return;
    const previous = stateRef.current.polls[pollId];
    const me = stateRef.current.userId;
    // Move the bars as the button is released rather than a round trip later.
    // The broadcast that follows replaces this with the server's tally, and a
    // refusal puts back exactly what was there.
    if (previous && me) {
      dispatch({
        type: "UPDATE_POLL",
        payload: {
          ...previous,
          voters: previous.voters.map((voters, index) => {
            const without = voters.filter((id) => id !== me);
            return options.includes(index) ? [...without, me] : without;
          }),
        },
      });
    }
    try {
      const { poll } = await apiVotePoll(roomId, pollId, options);
      dispatch({ type: "UPDATE_POLL", payload: poll });
    } catch (err) {
      if (previous) dispatch({ type: "UPDATE_POLL", payload: previous });
      throw err;
    }
  }, []);

  const closePoll = useCallback(async (pollId: string) => {
    const roomId = stateRef.current.currentRoomId;
    if (!roomId) return;
    const { poll } = await apiClosePoll(roomId, pollId);
    dispatch({ type: "UPDATE_POLL", payload: poll });
  }, []);

  const loadPoll = useCallback(async (pollId: string) => {
    const roomId = stateRef.current.currentRoomId;
    if (!roomId) return;
    const { poll } = await apiGetPoll(roomId, pollId);
    dispatch({ type: "UPDATE_POLL", payload: poll });
  }, []);

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

  /**
   * Ask the server to describe every call it knows this user can see.
   *
   * The socket answers from memory and covers every room at once, so it is both
   * cheaper than the REST call and wider — which matters because a call in a
   * room that is not on screen still has a sidebar row and a DM bar to keep
   * right. Answers false when there is no open socket to ask on.
   */
  const requestVoiceSync = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify({ type: "voice_state_request" }));
    return true;
  }, []);

  const loadVoiceMembers = useCallback(async (forRoomId?: string) => {
    if (requestVoiceSync()) return;
    // No socket: fall back to the one room the REST endpoint can describe.
    // A caller mid-room-switch names it, since the store may not have caught up.
    const roomId = forRoomId ?? stateRef.current.currentRoomId;
    if (!roomId) return;
    try {
      const voiceData = await apiGetVoiceMembers(roomId);
      const channels: Record<string, { roomId: string; occupiedSince: number | null; members: VoiceChannelMember[] }> = {};
      for (const [channelId, members] of Object.entries(voiceData.voice_channels || {})) {
        channels[channelId] = {
          roomId,
          occupiedSince: voiceData.occupied_since?.[channelId] ?? null,
          members: (members as any[]).map((m: any) => ({
            userId: m.user_id || m.userId,
            muted: !!m.muted,
            deafened: m.deafened ?? false,
            screen_sharing: !!m.screen_sharing,
            webcam_sharing: !!m.webcam_sharing,
            force_muted: m.force_muted ?? false,
            clipping: m.clipping ?? false,
            x: typeof m.x === "number" ? m.x : undefined,
            y: typeof m.y === "number" ? m.y : undefined,
          })),
        };
      }
      // Scoped to this room: the endpoint was told nothing about the others, so
      // it must not be read as saying their calls have ended.
      dispatch({ type: "SYNC_VOICE_STATE", payload: { roomId, channels } });
    } catch {}
  }, [requestVoiceSync]);
  loadVoiceMembersRef.current = loadVoiceMembers;

  /** Presence for everyone in the room on screen.
   *
   *  Polled, and asked for again whenever the socket has been away: a status
   *  that changed while it was down was broadcast to nobody. */
  const loadPresence = useCallback(async (forRoomId?: string) => {
    const roomId = forRoomId ?? stateRef.current.currentRoomId;
    if (!roomId) return;
    try {
      const data = await apiGetPresence(roomId);
      const mapped: Record<string, { status: string; customStatus?: string; avatarUrl?: string; about?: string; bannerUrl?: string; displayName?: string; nameFontUrl?: string; profileTheme?: unknown; isMobile?: boolean; steamGame?: string; steamAppId?: string; gameSessionStart?: number }> = {};
      for (const [uid, p] of Object.entries(data.presence)) {
        const pAny = p as any;
        mapped[uid] = { status: pAny.status, customStatus: pAny.custom_status || undefined, avatarUrl: pAny.avatar_url || undefined, about: pAny.about || undefined, bannerUrl: pAny.banner_url || undefined, displayName: pAny.display_name || undefined, nameFontUrl: pAny.name_font_url || undefined, profileTheme: pAny.profile_theme || undefined, isMobile: pAny.is_mobile || false, steamGame: pAny.steam_game || undefined, steamAppId: pAny.steam_appid || undefined, gameSessionStart: pAny.game_session_start || undefined };
      }
      dispatch({ type: "SET_PRESENCE", payload: mapped });
    } catch {}
  }, []);
  loadPresenceRef.current = loadPresence;

  /** Open a channel.
   *
   *  The same shape as `selectRoom`: messages, permissions and pins are three
   *  independent questions about the channel being opened, so they go out
   *  together and only the messages are awaited. Run one after another — which
   *  is what this did — the timeline waited on two answers it never reads.
   */
  const selectChannel = useCallback(async (channelId: string) => {
    dispatch({ type: "SELECT_CHANNEL", payload: channelId });
    const cur = stateRef.current;
    const roomId = cur.currentRoomId;
    if (!roomId) return;

    // Whether this switch is still the one on screen, as in `selectRoom`: these
    // no longer finish in order, and a slow answer for the channel someone just
    // left must not paint over the one they are now in.
    const stillCurrent = () =>
      stateRef.current.currentRoomId === roomId &&
      stateRef.current.currentChannelId === channelId;

    // Overwrites make permissions channel-scoped, so they follow the channel.
    void apiGetMyPermissions(roomId, channelId)
      .then((permsData) => {
        if (!stillCurrent()) return;
        dispatch({ type: "SET_MY_PERMISSIONS", payload: permsData.permissions });
      })
      .catch(() => {
        if (!stillCurrent()) return;
        dispatch({ type: "SET_MY_PERMISSIONS", payload: null });
      });
    void apiGetPins(roomId, channelId)
      .then((page) => {
        if (!stillCurrent()) return;
        dispatch({
          type: "SET_PINNED_MESSAGES",
          payload: { pins: page.items, hasMore: page.hasMore, nextOffset: page.nextOffset },
        });
      })
      .catch(() => {
        if (!stillCurrent()) return;
        dispatch({
          type: "SET_PINNED_MESSAGES",
          payload: { pins: [], hasMore: false, nextOffset: 0 },
        });
      });

    const msgData = await apiGetMessages(roomId, 50, undefined, undefined, channelId);
    const messages = msgData.chunk.filter((m) => m.type === "m.room.message");
    dispatch({
      type: "SET_MESSAGES",
      payload: {
        messages,
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
    async (roomId: string, settings: { name?: string; icon_url?: string; tags?: string[]; custom_emojis?: string[]; emoji_aliases?: Record<string, string>; unlisted?: boolean; password?: string; remove_password?: boolean; read_only?: boolean; sounds?: Record<string, string>; entrance_sounds_enabled?: boolean }) => {
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
      const { groups, order } = await apiGetRoomGroups();
      dispatch({ type: "SET_ROOM_GROUPS", payload: groups });
      dispatch({ type: "SET_SIDEBAR_ORDER", payload: order });
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

  /** Applied before it is saved: a dragged icon that waits for a round trip
   *  to move springs back to where it was and lands a moment later, which
   *  reads as the drag having failed. The server is the record, so a refusal
   *  reloads rather than leaving the two disagreeing. */
  const setSidebarOrder = useCallback(async (order: string[]) => {
    dispatch({ type: "SET_SIDEBAR_ORDER", payload: order });
    try {
      await apiSetSidebarOrder(order);
    } catch {
      await loadRoomGroups();
    }
  }, [loadRoomGroups]);

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

  const updateProfile = useCallback((profile: { avatarUrl?: string; bannerUrl?: string; about?: string; customStatus?: string; displayName?: string; nameFontUrl?: string; profileTheme?: ProfileTheme; entranceSoundUrl?: string }) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      const payload: any = { type: "set_profile" };
      if (profile.avatarUrl !== undefined) payload.avatar_url = profile.avatarUrl;
      if (profile.bannerUrl !== undefined) payload.banner_url = profile.bannerUrl;
      if (profile.about !== undefined) payload.about = profile.about;
      if (profile.customStatus !== undefined) payload.custom_status = profile.customStatus;
      if (profile.displayName !== undefined) payload.display_name = profile.displayName;
      if (profile.nameFontUrl !== undefined) payload.name_font_url = profile.nameFontUrl;
      if (profile.profileTheme !== undefined) payload.profile_theme = profile.profileTheme;
      if (profile.entranceSoundUrl !== undefined) payload.entrance_sound_url = profile.entranceSoundUrl;
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
      openMessage,
      closeThread,
      sendThreadMessage,
      setThreadName,
      deleteThread,
      deleteMessage,
      hardDeleteNotification,
      editMessage,
      addReaction,
      loadPins,
      loadEvents,
      createEvent,
      updateEvent,
      deleteEvent,
      createPoll,
      votePoll,
      closePoll,
      loadPoll,
      setRsvp,
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
      setSidebarOrder,
      loadFriends,
      loadUnreads,
      markChannelRead,
      loadNotificationSettings,
      loadContinuity,
      loadActiveThreads,
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
    [login, register, logout, deleteAccount, loadRooms, selectRoom, loadOlderMessages, loadMessagesAround, sendMessage, openThread, openMessage, closeThread, sendThreadMessage, setThreadName, deleteThread, deleteMessage, hardDeleteNotification, editMessage, addReaction, loadPins, loadEvents, createEvent, updateEvent, deleteEvent, createPoll, votePoll, closePoll, loadPoll, setRsvp, loadMorePins, loadMoreSearchResults, pinMessage, unpinMessage, createRoom, joinRoom, leaveRoom, loadVoiceMembers, sendTyping, getAllRooms, openDM, addToGroupDM, updateTopic, updateRoomSettings, setCustomStatus, setManualStatus, updateProfile, kickMember, banMember, unbanMember, setMemberRole, setNameColors, selectChannel, createChannel, updateChannel, deleteChannel, loadRoles, createRole, updateRole, deleteRole, assignMemberRoles, loadRoomGroups, createRoomGroup, deleteRoomGroup, renameRoomGroup, setGroupRooms, toggleGroupCollapsed, setSidebarOrder, loadFriends, loadUnreads, markChannelRead, loadNotificationSettings, loadContinuity, loadActiveThreads, saveDraft, saveResumePoint, setNotificationLevel, moderateVoice, sendFriendRequest, acceptFriendRequest, rejectFriendRequest, removeFriend, blockUser, unblockUser],
  );

  return (
    <AppActionsContext.Provider value={actions}>
      <AppStateContext.Provider value={state}>{children}</AppStateContext.Provider>
    </AppActionsContext.Provider>
  );
}
