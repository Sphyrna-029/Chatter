import type { Dispatch, MutableRefObject } from "react";
import type { Action, AppState } from "./types";
import { apiSync, apiGetPresence } from "../api";

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
        const myUsername = stateRef.current.userId?.split(":")[0]?.substring(1) ?? "";
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
            [msg.user_id]: { status: "active", customStatus: existing?.customStatus, avatarUrl: existing?.avatarUrl, about: existing?.about },
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
  };
}
