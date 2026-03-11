import type { Dispatch, MutableRefObject } from "react";
import type { Action, AppState } from "./types";
import { apiSync, apiGetPresence } from "../api";
import { displayUserId } from "@/lib/utils";

async function playReversed(url: string) {
  try {
    const ctx = new AudioContext();
    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
      audioBuffer.getChannelData(c).reverse();
    }
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);
    source.start();
    source.onended = () => ctx.close();
  } catch {}
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
        dispatch({ type: "ADD_MESSAGE", payload: msg });
      } else if (msg.content?.msgtype !== "m.system" && msg.sender !== stateRef.current.userId) {
        const isDm = stateRef.current.roomInfoMap[msg.room_id]?.is_direct === true;
        const myUsername = stateRef.current.userId ? displayUserId(stateRef.current.userId) : "";
        const hasMention = myUsername !== "" && msg.content?.body?.includes(`@${myUsername}`) === true;
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
            const mapped: Record<string, { status: string; customStatus?: string; avatarUrl?: string; about?: string; bannerUrl?: string; displayName?: string; nameFontUrl?: string }> = {};
            for (const [uid, p] of Object.entries(presData.presence)) {
              const pAny = p as any;
              mapped[uid] = { status: pAny.status, customStatus: pAny.custom_status || undefined, avatarUrl: pAny.avatar_url || undefined, about: pAny.about || undefined, bannerUrl: pAny.banner_url || undefined, displayName: pAny.display_name || undefined, nameFontUrl: pAny.name_font_url || undefined };
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
            [msg.user_id]: { status: "active", customStatus: existing?.customStatus, avatarUrl: existing?.avatarUrl, about: existing?.about, displayName: existing?.displayName, nameFontUrl: existing?.nameFontUrl },
          },
        });
      }
    } else if (msg.type === "voice_user_joined") {
      const isVoiceRoom = msg.room_id === stateRef.current.currentRoomId || msg.room_id === stateRef.current.voiceRoomId;
      if (isVoiceRoom) {
        dispatch({ type: "VOICE_USER_JOINED", payload: msg.user_id });
        if (stateRef.current.inVoiceChannel || msg.user_id === stateRef.current.userId) {
          new Audio("/external/vc-join.wav").play().catch(() => {});
        }
      }
    } else if (msg.type === "voice_user_left") {
      const isVoiceRoom = msg.room_id === stateRef.current.currentRoomId || msg.room_id === stateRef.current.voiceRoomId;
      if (isVoiceRoom) {
        dispatch({ type: "VOICE_USER_LEFT", payload: msg.user_id });
        if (stateRef.current.inVoiceChannel || msg.user_id === stateRef.current.userId) {
          playReversed("/external/vc-join.wav");
        }
      }
    } else if (msg.type === "voice_user_muted") {
      const isVoiceRoom = msg.room_id === stateRef.current.currentRoomId || msg.room_id === stateRef.current.voiceRoomId;
      if (isVoiceRoom) {
        dispatch({
          type: "VOICE_USER_MUTED",
          payload: { userId: msg.user_id, muted: msg.muted },
        });
      }
    } else if (msg.type === "screen_share_started") {
      const isVoiceRoom = msg.room_id === stateRef.current.currentRoomId || msg.room_id === stateRef.current.voiceRoomId;
      if (isVoiceRoom) {
        dispatch({ type: "SCREEN_SHARE_STARTED", payload: msg.user_id });
      }
    } else if (msg.type === "screen_share_stopped") {
      const isVoiceRoom = msg.room_id === stateRef.current.currentRoomId || msg.room_id === stateRef.current.voiceRoomId;
      if (isVoiceRoom) {
        dispatch({ type: "SCREEN_SHARE_STOPPED", payload: msg.user_id });
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
