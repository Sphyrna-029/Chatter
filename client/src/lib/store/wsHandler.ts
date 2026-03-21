import type { Dispatch, MutableRefObject } from "react";
import type { Action, AppState } from "./types";
import { apiSync, apiGetPresence } from "../api";
import { displayUserId } from "@/lib/utils";

// Pre-decode and cache the reversed leave sound so playback is instant
let cachedLeaveBuffer: AudioBuffer | null = null;
let cacheLoading = false;

function ensureLeaveBufferCached() {
  if (cachedLeaveBuffer || cacheLoading) return;
  cacheLoading = true;
  (async () => {
    try {
      const ctx = new AudioContext();
      const response = await fetch("/external/vc-join.wav");
      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
      for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
        audioBuffer.getChannelData(c).reverse();
      }
      cachedLeaveBuffer = audioBuffer;
      await ctx.close();
    } catch {
      cacheLoading = false;
    }
  })();
}

// Start caching immediately on module load
ensureLeaveBufferCached();

function playLeaveSound() {
  try {
    if (!cachedLeaveBuffer) {
      ensureLeaveBufferCached();
      return;
    }
    const ctx = new AudioContext();
    const source = ctx.createBufferSource();
    source.buffer = cachedLeaveBuffer;
    source.connect(ctx.destination);
    source.start();
    source.onended = () => ctx.close();
  } catch {}
}

function hasRoleMention(body: string, stateRef: MutableRefObject<AppState>): boolean {
  const userId = stateRef.current.userId;
  if (!userId) return false;
  const mentions = body.match(/@(\w+)/g);
  if (!mentions) return false;
  const mentionedNames = mentions.map((m) => m.slice(1).toLowerCase());

  // Check built-in role (owner/moderator) from room members list
  const myMember = stateRef.current.roomMembers.find((m) => m.userId === userId);
  if (myMember && (myMember.role === "owner" || myMember.role === "moderator")) {
    if (mentionedNames.includes(myMember.role)) return true;
  }

  // Check custom roles
  const myRoleIds = stateRef.current.memberCustomRoles[userId] || [];
  if (myRoleIds.length > 0) {
    const myRoleNames = myRoleIds
      .map((rid) => stateRef.current.customRoles.find((r) => r.role_id === rid))
      .filter(Boolean)
      .map((r) => r!.name.toLowerCase());
    if (myRoleNames.some((name) => mentionedNames.includes(name))) return true;
  }

  return false;
}

export function createWsMessageHandler(
  dispatch: Dispatch<Action>,
  stateRef: MutableRefObject<AppState>,
  typingTimeoutsRef: MutableRefObject<Record<string, ReturnType<typeof setTimeout>>>,
  loadRoomsRef: MutableRefObject<() => Promise<void>>,
) {
  return (msg: any) => {
    if (msg.type === "m.room.message") {
      if (msg.room_id === stateRef.current.currentRoomId) {
        const msgChannelId = msg.channel_id || msg.content?.channel_id;
        const currentChannelId = stateRef.current.currentChannelId;
        // Only add to displayed messages if it belongs to the current channel
        const isForCurrentChannel = msgChannelId
          ? msgChannelId === currentChannelId
          : !currentChannelId;
        if (isForCurrentChannel) {
          dispatch({ type: "ADD_MESSAGE", payload: msg });
        } else if (msgChannelId && msg.sender !== stateRef.current.userId && msg.content?.msgtype !== "m.system") {
          // Track per-channel unreads/mentions for messages in a different channel
          dispatch({ type: "INCREMENT_CHANNEL_UNREAD", payload: msgChannelId });
          const myUsername = stateRef.current.userId ? displayUserId(stateRef.current.userId) : "";
          const bodyText = msg.content?.body || "";
          const hasUserMention = myUsername !== "" && bodyText.includes(`@${myUsername}`);
          if (hasUserMention || hasRoleMention(bodyText, stateRef)) {
            dispatch({ type: "SET_CHANNEL_MENTION", payload: { channelId: msgChannelId, hasMention: true } });
            dispatch({ type: "SET_MENTION", payload: { roomId: msg.room_id, hasMention: true } });
            const ownStatus = stateRef.current.userPresence[stateRef.current.userId ?? ""]?.status;
            if (ownStatus !== "dnd") new Audio("/external/vc-join.wav").play().catch(() => {});
          }
        }
      } else if (msg.content?.msgtype !== "m.system" && msg.sender !== stateRef.current.userId) {
        const isDm = stateRef.current.roomInfoMap[msg.room_id]?.is_direct === true;
        const myUsername = stateRef.current.userId ? displayUserId(stateRef.current.userId) : "";
        const bodyText = msg.content?.body || "";
        const hasMention = (myUsername !== "" && bodyText.includes(`@${myUsername}`)) || hasRoleMention(bodyText, stateRef);
        const ownStatus = stateRef.current.userPresence[stateRef.current.userId ?? ""]?.status;
        if (isDm || hasMention) {
          if (ownStatus !== "dnd") new Audio("/external/vc-join.wav").play().catch(() => {});
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
                    e.content.displayname || displayUserId(e.state_key),
                  role: e.content.role || "member",
                  joinedAt: e.content.joined_at || undefined,
                })),
              });
            }
            const presData = await apiGetPresence(curRoom);
            const mapped: Record<string, { status: string; customStatus?: string; avatarUrl?: string; about?: string; bannerUrl?: string; displayName?: string; nameFontUrl?: string; steamGame?: string; steamAppId?: string; gameSessionStart?: number; spotifyTrack?: string; spotifyArtist?: string; spotifyAlbumArt?: string }> = {};
            for (const [uid, p] of Object.entries(presData.presence)) {
              const pAny = p as any;
              mapped[uid] = { status: pAny.status, customStatus: pAny.custom_status || undefined, avatarUrl: pAny.avatar_url || undefined, about: pAny.about || undefined, bannerUrl: pAny.banner_url || undefined, displayName: pAny.display_name || undefined, nameFontUrl: pAny.name_font_url || undefined, steamGame: pAny.steam_game || undefined, steamAppId: pAny.steam_appid || undefined, gameSessionStart: pAny.game_session_start || undefined, spotifyTrack: pAny.spotify_track || undefined, spotifyArtist: pAny.spotify_artist || undefined, spotifyAlbumArt: pAny.spotify_album_art || undefined };
            }
            dispatch({ type: "SET_PRESENCE", payload: mapped });
          } catch {}
        })();
      }
      // Refresh room list (member counts may have changed)
      loadRoomsRef.current();
    } else if (msg.type === "m.room.deleted") {
      // Room was deleted by the owner — deselect if active and refresh room list
      if (msg.room_id === stateRef.current.currentRoomId) {
        dispatch({ type: "SELECT_ROOM", payload: null });
      }
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
    } else if (msg.type === "m.thread.message") {
      if (msg.room_id === stateRef.current.currentRoomId) {
        // Update thread reply count on the root message
        dispatch({
          type: "UPDATE_THREAD_REPLY_COUNT",
          payload: { eventId: msg.thread_id, count: msg.thread_reply_count },
        });
        // If the thread panel is open for this thread, add the message
        if (stateRef.current.activeThreadEventId === msg.thread_id) {
          dispatch({
            type: "ADD_THREAD_MESSAGE",
            payload: {
              event_id: msg.event_id,
              sender: msg.sender,
              room_id: msg.room_id,
              origin_server_ts: msg.origin_server_ts,
              type: "m.room.message",
              thread_id: msg.thread_id,
              content: msg.content,
            },
          });
        }
      }
    } else if (msg.type === "m.thread.name") {
      if (msg.room_id === stateRef.current.currentRoomId) {
        dispatch({
          type: "SET_THREAD_NAME",
          payload: { eventId: msg.thread_id, name: msg.name },
        });
      }
    } else if (msg.type === "user_typing") {
      const typingChannelMatches = msg.channel_id
        ? msg.channel_id === stateRef.current.currentChannelId
        : !stateRef.current.currentChannelId;
      if (
        msg.room_id === stateRef.current.currentRoomId &&
        msg.user_id !== stateRef.current.userId &&
        typingChannelMatches
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
            [msg.user_id]: { status: "active", customStatus: existing?.customStatus, avatarUrl: existing?.avatarUrl, about: existing?.about, displayName: existing?.displayName, nameFontUrl: existing?.nameFontUrl, steamGame: existing?.steamGame, spotifyTrack: existing?.spotifyTrack, spotifyArtist: existing?.spotifyArtist, spotifyAlbumArt: existing?.spotifyAlbumArt },
          },
        });
      }
    } else if (msg.type === "voice_user_joined") {
      const isVoiceRoom = msg.room_id === stateRef.current.currentRoomId || msg.room_id === stateRef.current.voiceRoomId;
      if (isVoiceRoom) {
        dispatch({ type: "VOICE_USER_JOINED", payload: msg.user_id });
        // Use the server's authoritative voice_members list and dispatch a single-channel
        // update (SET_VOICE_CHANNEL) so rapid join+leave events for different channels
        // cannot clobber each other via a stale stateRef snapshot.
        const isCurrentRoom = msg.room_id === stateRef.current.currentRoomId;
        if (msg.channel_id && isCurrentRoom && Array.isArray(msg.voice_members)) {
          const existing = stateRef.current.voiceChannelMembers[msg.channel_id] || [];
          const members = (msg.voice_members as string[]).map((uid: string) => {
            const ex = existing.find((m) => m.userId === uid);
            return ex ?? { userId: uid, muted: false, deafened: false, screen_sharing: false };
          });
          dispatch({ type: "SET_VOICE_CHANNEL", payload: { channelId: msg.channel_id, members } });
          if (msg.occupied_since) {
            dispatch({ type: "UPDATE_VOICE_CHANNEL_OCCUPIED_SINCE", payload: { channelId: msg.channel_id, since: msg.occupied_since as number } });
          }
        }
        const inSameChannel = stateRef.current.inVoiceChannel &&
          (msg.channel_id
            ? msg.channel_id === stateRef.current.voiceChannelId
            : msg.room_id === stateRef.current.voiceRoomId);
        if (inSameChannel || msg.user_id === stateRef.current.userId) {
          new Audio("/external/vc-join.wav").play().catch(() => {});
        }
      }
    } else if (msg.type === "voice_user_left") {
      const isVoiceRoom = msg.room_id === stateRef.current.currentRoomId || msg.room_id === stateRef.current.voiceRoomId;
      if (isVoiceRoom) {
        dispatch({ type: "VOICE_USER_LEFT", payload: msg.user_id });
        // Same pattern: use server's authoritative remaining list and a single-channel dispatch.
        const isCurrentRoom = msg.room_id === stateRef.current.currentRoomId;
        if (msg.channel_id && isCurrentRoom && Array.isArray(msg.voice_members)) {
          const existing = stateRef.current.voiceChannelMembers[msg.channel_id] || [];
          const members = (msg.voice_members as string[]).map((uid: string) => {
            const ex = existing.find((m) => m.userId === uid);
            return ex ?? { userId: uid, muted: false, deafened: false, screen_sharing: false };
          });
          dispatch({ type: "SET_VOICE_CHANNEL", payload: { channelId: msg.channel_id, members } });
          dispatch({ type: "UPDATE_VOICE_CHANNEL_OCCUPIED_SINCE", payload: { channelId: msg.channel_id, since: msg.occupied_since as number | null ?? null } });
        }
        const inSameChannelLeave = stateRef.current.inVoiceChannel &&
          (msg.channel_id
            ? msg.channel_id === stateRef.current.voiceChannelId
            : msg.room_id === stateRef.current.voiceRoomId);
        if (inSameChannelLeave || msg.user_id === stateRef.current.userId) {
          playLeaveSound();
        }
      }
    } else if (msg.type === "voice_user_muted") {
      const isVoiceRoom = msg.room_id === stateRef.current.currentRoomId || msg.room_id === stateRef.current.voiceRoomId;
      if (isVoiceRoom) {
        dispatch({ type: "VOICE_USER_MUTED", payload: { userId: msg.user_id, muted: msg.muted } });
        const isCurrentRoom = msg.room_id === stateRef.current.currentRoomId;
        if (msg.channel_id && isCurrentRoom) {
          const members = (stateRef.current.voiceChannelMembers[msg.channel_id] || []).map((m) =>
            m.userId === msg.user_id ? { ...m, muted: msg.muted as boolean } : m
          );
          dispatch({ type: "SET_VOICE_CHANNEL", payload: { channelId: msg.channel_id, members } });
        }
      }
    } else if (msg.type === "voice_user_deafened") {
      const isVoiceRoom = msg.room_id === stateRef.current.currentRoomId || msg.room_id === stateRef.current.voiceRoomId;
      if (isVoiceRoom) {
        const isCurrentRoom = msg.room_id === stateRef.current.currentRoomId;
        if (msg.channel_id && isCurrentRoom) {
          const members = (stateRef.current.voiceChannelMembers[msg.channel_id] || []).map((m) =>
            m.userId === msg.user_id ? { ...m, deafened: msg.deafened as boolean } : m
          );
          dispatch({ type: "SET_VOICE_CHANNEL", payload: { channelId: msg.channel_id, members } });
        }
      }
    } else if (msg.type === "screen_share_started") {
      const isVoiceRoom = msg.room_id === stateRef.current.currentRoomId || msg.room_id === stateRef.current.voiceRoomId;
      if (isVoiceRoom) {
        dispatch({ type: "SCREEN_SHARE_STARTED", payload: msg.user_id });
        // Auto-open the screen viewer for other users when someone starts sharing
        if (msg.user_id !== stateRef.current.userId && stateRef.current.inVoiceChannel) {
          dispatch({ type: "SET_SCREEN_VIEWER", payload: { open: true, sharer: msg.user_id } });
        }
        // Only update per-channel voice members if the event is for the currently viewed room
        const isCurrentRoom = msg.room_id === stateRef.current.currentRoomId;
        if (msg.channel_id && isCurrentRoom) {
          const cur = { ...stateRef.current.voiceChannelMembers };
          cur[msg.channel_id] = (cur[msg.channel_id] || []).map((m: any) =>
            m.userId === msg.user_id ? { ...m, screen_sharing: true } : m
          );
          dispatch({ type: "SET_VOICE_CHANNEL_MEMBERS", payload: cur });
        }
      }
    } else if (msg.type === "screen_share_stopped") {
      const isVoiceRoom = msg.room_id === stateRef.current.currentRoomId || msg.room_id === stateRef.current.voiceRoomId;
      if (isVoiceRoom) {
        dispatch({ type: "SCREEN_SHARE_STOPPED", payload: msg.user_id });
        // Only update per-channel voice members if the event is for the currently viewed room
        const isCurrentRoom = msg.room_id === stateRef.current.currentRoomId;
        if (msg.channel_id && isCurrentRoom) {
          const cur = { ...stateRef.current.voiceChannelMembers };
          cur[msg.channel_id] = (cur[msg.channel_id] || []).map((m: any) =>
            m.userId === msg.user_id ? { ...m, screen_sharing: false } : m
          );
          dispatch({ type: "SET_VOICE_CHANNEL_MEMBERS", payload: cur });
        }
      }
    } else if (msg.type === "screen_viewers_update") {
      dispatch({
        type: "SET_SCREEN_VIEWERS",
        payload: { sharerId: msg.sharer_user_id, viewers: msg.viewers || [] },
      });
    } else if (msg.type === "m.reply_notification") {
      if (msg.room_id !== stateRef.current.currentRoomId) {
        const ownStatus = stateRef.current.userPresence[stateRef.current.userId ?? ""]?.status;
        if (ownStatus !== "dnd") new Audio("/external/vc-join.wav").play().catch(() => {});
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
              bannerUrl: msg.banner_url !== undefined ? (msg.banner_url || undefined) : existing?.bannerUrl,
              displayName: msg.display_name !== undefined ? (msg.display_name || undefined) : existing?.displayName,
              nameFontUrl: msg.name_font_url !== undefined ? (msg.name_font_url || undefined) : existing?.nameFontUrl,
              isMobile: msg.is_mobile !== undefined ? msg.is_mobile : existing?.isMobile,
              steamGame: msg.steam_game !== undefined ? (msg.steam_game || undefined) : existing?.steamGame,
              steamAppId: msg.steam_appid !== undefined ? (msg.steam_appid || undefined) : existing?.steamAppId,
              gameSessionStart: msg.game_session_start !== undefined ? (msg.game_session_start || undefined) : existing?.gameSessionStart,
              spotifyTrack: msg.spotify_track !== undefined ? (msg.spotify_track || undefined) : existing?.spotifyTrack,
              spotifyArtist: msg.spotify_artist !== undefined ? (msg.spotify_artist || undefined) : existing?.spotifyArtist,
              spotifyAlbumArt: msg.spotify_album_art !== undefined ? (msg.spotify_album_art || undefined) : existing?.spotifyAlbumArt,
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
          custom_emojis: msg.content?.custom_emojis,
          emoji_aliases: msg.content?.emoji_aliases,
          unlisted: msg.content?.unlisted,
          has_password: msg.content?.has_password,
          read_only: msg.content?.read_only,
          banner_url: msg.content?.banner_url,
        },
      });
    }
    else if (msg.type === "m.room.topic") {
      dispatch({
        type: "UPDATE_ROOM_TOPIC",
        payload: { roomId: msg.room_id, topic: msg.content?.topic || "" },
      });
    }
    else if (msg.type === "m.room.member_role") {
      if (msg.room_id === stateRef.current.currentRoomId) {
        dispatch({
          type: "UPDATE_MEMBER_ROLE",
          payload: { userId: msg.user_id, role: msg.role },
        });
      }
    }
    else if (msg.type === "m.room.name_colors") {
      dispatch({
        type: "UPDATE_NAME_COLORS",
        payload: {
          roomId: msg.room_id,
          owner_name_color: msg.content?.owner_name_color || "",
          mod_name_color: msg.content?.mod_name_color || "",
        },
      });
    }
    else if (msg.type === "m.room.kick") {
      // We got kicked from a room
      if (msg.user_id === stateRef.current.userId) {
        if (msg.room_id === stateRef.current.currentRoomId) {
          dispatch({ type: "SELECT_ROOM", payload: null });
        }
        loadRoomsRef.current();
      }
    }
    else if (msg.type === "m.room.created") {
      // A new DM room was created — refresh rooms list so it appears instantly
      loadRoomsRef.current();
    }
    // Channel CRUD events
    else if (msg.type === "m.channel.created") {
      if (msg.room_id === stateRef.current.currentRoomId && msg.channel) {
        dispatch({ type: "ADD_CHANNEL", payload: msg.channel });
      }
    }
    else if (msg.type === "m.channel.updated") {
      if (msg.room_id === stateRef.current.currentRoomId && msg.content) {
        dispatch({ type: "UPDATE_CHANNEL", payload: msg.content });
      }
    }
    else if (msg.type === "m.channel.deleted") {
      if (msg.room_id === stateRef.current.currentRoomId && msg.channel_id) {
        dispatch({ type: "REMOVE_CHANNEL", payload: msg.channel_id });
      }
    }
    else if (msg.type === "m.channel.category_created") {
      if (msg.room_id === stateRef.current.currentRoomId && msg.category) {
        dispatch({ type: "ADD_CHANNEL_CATEGORY", payload: msg.category });
      }
    }
    else if (msg.type === "m.channel.category_updated") {
      if (msg.room_id === stateRef.current.currentRoomId && msg.content) {
        dispatch({ type: "UPDATE_CHANNEL_CATEGORY", payload: msg.content });
      }
    }
    else if (msg.type === "m.channel.category_deleted") {
      if (msg.room_id === stateRef.current.currentRoomId && msg.category_id) {
        dispatch({ type: "REMOVE_CHANNEL_CATEGORY", payload: msg.category_id });
      }
    }
    // Custom role events
    else if (msg.type === "m.room.role_created") {
      if (msg.room_id === stateRef.current.currentRoomId && msg.role) {
        dispatch({ type: "ADD_CUSTOM_ROLE", payload: msg.role });
      }
    }
    else if (msg.type === "m.room.role_updated") {
      if (msg.room_id === stateRef.current.currentRoomId && msg.content) {
        dispatch({ type: "UPDATE_CUSTOM_ROLE", payload: msg.content });
      }
    }
    else if (msg.type === "m.room.role_deleted") {
      if (msg.room_id === stateRef.current.currentRoomId && msg.role_id) {
        dispatch({ type: "REMOVE_CUSTOM_ROLE", payload: msg.role_id });
      }
    }
    else if (msg.type === "m.room.member_roles_updated") {
      if (msg.room_id === stateRef.current.currentRoomId && msg.user_id) {
        dispatch({ type: "UPDATE_MEMBER_CUSTOM_ROLES", payload: { userId: msg.user_id, roleIds: msg.role_ids || [] } });
      }
    }
    // Forum real-time events — dispatch as custom events for ForumArea to handle
    else if (msg.type === "forum.post.created" || msg.type === "forum.post.deleted" ||
             msg.type === "forum.comment.created" || msg.type === "forum.comment.deleted" ||
             msg.type === "forum.post.edited" || msg.type === "forum.comment.edited") {
      window.dispatchEvent(
        new CustomEvent(msg.type, { detail: msg })
      );
      // Set mention badge for forum posts from other rooms
      if (msg.type === "forum.post.created" && msg.room_id !== stateRef.current.currentRoomId && msg.post?.author !== stateRef.current.userId) {
        dispatch({
          type: "SET_MENTION",
          payload: { roomId: msg.room_id, hasMention: true },
        });
      }
    }
    // Tank Wars real-time events — dispatch as custom events for TankWarArea to handle
    else if (msg.type === "tankwar_player_joined" || msg.type === "tankwar_player_ready" ||
             msg.type === "tankwar_script_submitted" || msg.type === "tankwar_game_start" ||
             msg.type === "tankwar_tick" || msg.type === "tankwar_game_over" ||
             msg.type === "tankwar_reset_vote" || msg.type === "tankwar_game_reset") {
      window.dispatchEvent(
        new CustomEvent(msg.type, { detail: msg })
      );
    }
    // Tug of War real-time events
    else if (msg.type === "tugofwar_game_created" || msg.type === "tugofwar_player_update" ||
             msg.type === "tugofwar_game_started" || msg.type === "tugofwar_rope_update" ||
             msg.type === "tugofwar_game_over" || msg.type === "tugofwar_reset_vote" ||
             msg.type === "tugofwar_game_reset") {
      window.dispatchEvent(new CustomEvent(msg.type, { detail: msg }));
    }
    // Whiteboard real-time events — dispatch as custom events for WhiteboardArea to handle
    else if (msg.type === "whiteboard_stroke" || msg.type === "whiteboard_cursor" ||
             msg.type === "whiteboard_clear" || msg.type === "whiteboard_undo") {
      window.dispatchEvent(
        new CustomEvent(msg.type, { detail: msg })
      );
    }
    // Watch Party real-time events
    else if (msg.type === "watchparty_sync" || msg.type === "watchparty_video_changed") {
      window.dispatchEvent(new CustomEvent(msg.type, { detail: msg }));
    }
    // Friend events
    else if (msg.type === "friend_request") {
      dispatch({
        type: "ADD_INCOMING_REQUEST",
        payload: { userId: msg.from_user, requestId: msg.request_id },
      });
    }
    else if (msg.type === "friend_request_accepted") {
      const friendUserId = msg.user_id;
      dispatch({ type: "ADD_FRIEND", payload: friendUserId });
      dispatch({ type: "REMOVE_INCOMING_REQUEST", payload: friendUserId });
      dispatch({ type: "REMOVE_OUTGOING_REQUEST", payload: friendUserId });
    }
    else if (msg.type === "friend_removed") {
      dispatch({ type: "REMOVE_FRIEND", payload: msg.user_id });
    }
    // WebRTC signaling messages are handled by the voice/screen hooks
    // by subscribing to raw WS messages via a custom event
    window.dispatchEvent(
      new CustomEvent("ws-message", { detail: msg })
    );
  };
}
