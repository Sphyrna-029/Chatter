import type { AppState, Action } from "./types";
import { initialState } from "./types";

export function reducer(state: AppState, action: Action): AppState {
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
    case "SELECT_ROOM": {
      // When in a voice channel, preserve voice/screen share state across room switches
      const preserveVoice = state.inVoiceChannel;
      return {
        ...state,
        currentRoomId: action.payload,
        currentChannelId: null,
        channels: [],
        channelCategories: [],
        messages: [],
        hasMoreMessages: false,
        oldestMessageIndex: null,
        loadingOlderMessages: false,
        roomMembers: [],
        voiceMembers: preserveVoice ? state.voiceMembers : [],
        voiceMemberStates: preserveVoice ? state.voiceMemberStates : {},
        voiceChannelMembers: preserveVoice ? state.voiceChannelMembers : {},
        voiceChannelOccupiedSince: preserveVoice ? state.voiceChannelOccupiedSince : {},
        activeScreenSharers: preserveVoice ? state.activeScreenSharers : [],
        screenViewerOpen: preserveVoice ? state.screenViewerOpen : false,
        selectedScreenSharer: preserveVoice ? state.selectedScreenSharer : null,
        selectedWebcamStreamer: preserveVoice ? state.selectedWebcamStreamer : null,
        screenViewers: preserveVoice ? state.screenViewers : {},
        typingUsers: [],
        adminDashboardOpen: false,
        roomMentions: action.payload
          ? { ...state.roomMentions, [action.payload]: 0 }
          : state.roomMentions,
        activeThreadEventId: null,
        threadRootMessage: null,
        threadMessages: [],
      };
    }
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
      if (state.messages.some((m) => m.event_id === action.payload.event_id)) return state;
      return { ...state, messages: [...state.messages, action.payload] };
    case "REDACT_MESSAGE":
      return {
        ...state,
        messages: state.messages.filter((m) => m.event_id !== action.payload),
      };
    case "REMOVE_MESSAGE":
      return {
        ...state,
        messages: state.messages.filter((m) => m.event_id !== action.payload),
      };
    case "EDIT_MESSAGE":
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.event_id === action.payload.eventId
            ? { ...m, edited: true, content: { ...m.content, body: action.payload.newBody, ...(action.payload.newEmbeds !== undefined ? { embeds: action.payload.newEmbeds } : {}) } }
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
    case "SCREEN_SHARE_STOPPED": {
      const { [action.payload]: _removedViewers, ...remainingViewers } = state.screenViewers;
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
        screenViewers: remainingViewers,
      };
    }
    case "SET_ACTIVE_SCREEN_SHARERS":
      return { ...state, activeScreenSharers: action.payload };
    case "SET_SCREEN_VIEWER": {
      const selectingSharer = action.payload.sharer !== undefined;
      const selectingWebcam = action.payload.webcamStreamer !== undefined;
      return {
        ...state,
        screenViewerOpen: action.payload.open ?? state.screenViewerOpen,
        selectedScreenSharer: selectingSharer
          ? (action.payload.sharer ?? null)
          : selectingWebcam
            ? null
            : state.selectedScreenSharer,
        selectedWebcamStreamer: selectingWebcam
          ? (action.payload.webcamStreamer ?? null)
          : selectingSharer
            ? null
            : state.selectedWebcamStreamer,
      };
    }
    case "SET_SCREEN_VIEWERS":
      return {
        ...state,
        screenViewers: {
          ...state.screenViewers,
          [action.payload.sharerId]: action.payload.viewers,
        },
      };
    case "WEBCAM_SHARE_STARTED":
      return {
        ...state,
        activeWebcamStreamers: state.activeWebcamStreamers.includes(action.payload)
          ? state.activeWebcamStreamers
          : [...state.activeWebcamStreamers, action.payload],
      };
    case "WEBCAM_SHARE_STOPPED":
      return {
        ...state,
        activeWebcamStreamers: state.activeWebcamStreamers.filter((id) => id !== action.payload),
      };
    case "SET_ACTIVE_WEBCAM_STREAMERS":
      return { ...state, activeWebcamStreamers: action.payload };
    case "SET_VIEW":
      return { ...state, currentView: action.payload };
    case "SET_MENTION":
      return {
        ...state,
        roomMentions: {
          ...state.roomMentions,
          [action.payload.roomId]: action.payload.hasMention
            ? (state.roomMentions[action.payload.roomId] || 0) + 1
            : 0,
        },
      };
    case "SET_REPLYING_TO":
      return { ...state, replyingTo: action.payload };
    case "OPEN_THREAD":
      return {
        ...state,
        activeThreadEventId: action.payload.eventId,
        threadRootMessage: action.payload.root,
        threadMessages: action.payload.messages,
      };
    case "CLOSE_THREAD":
      return {
        ...state,
        activeThreadEventId: null,
        threadRootMessage: null,
        threadMessages: [],
      };
    case "ADD_THREAD_MESSAGE":
      if (state.activeThreadEventId !== action.payload.thread_id) return state;
      if (state.threadMessages.some((m) => m.event_id === action.payload.event_id)) return state;
      return { ...state, threadMessages: [...state.threadMessages, action.payload] };
    case "UPDATE_THREAD_REPLY_COUNT":
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.event_id === action.payload.eventId
            ? { ...m, thread_reply_count: action.payload.count }
            : m
        ),
      };
    case "ADD_THREAD_PARTICIPANTS": {
      const mergeParticipants = (existing: string[] | undefined, added: string[]) => {
        const set = new Set(existing ?? []);
        added.forEach((p) => set.add(p));
        return Array.from(set);
      };
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.event_id === action.payload.eventId
            ? { ...m, thread_participants: mergeParticipants(m.thread_participants, action.payload.participants) }
            : m
        ),
        threadRootMessage:
          state.threadRootMessage?.event_id === action.payload.eventId
            ? { ...state.threadRootMessage, thread_participants: mergeParticipants(state.threadRootMessage.thread_participants, action.payload.participants) }
            : state.threadRootMessage,
      };
    }
    case "DELETE_THREAD":
      return {
        ...state,
        messages: state.messages.filter((m) => m.event_id !== action.payload),
        activeThreadEventId: state.activeThreadEventId === action.payload ? null : state.activeThreadEventId,
        threadRootMessage: state.threadRootMessage?.event_id === action.payload ? null : state.threadRootMessage,
        threadMessages: state.activeThreadEventId === action.payload ? [] : state.threadMessages,
      };
    case "SET_THREAD_NAME":
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.event_id === action.payload.eventId
            ? { ...m, thread_name: action.payload.name }
            : m
        ),
        threadRootMessage:
          state.threadRootMessage?.event_id === action.payload.eventId
            ? { ...state.threadRootMessage, thread_name: action.payload.name }
            : state.threadRootMessage,
      };
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
            ...(action.payload.custom_emojis !== undefined && { custom_emojis: action.payload.custom_emojis }),
            ...(action.payload.emoji_aliases !== undefined && { emoji_aliases: action.payload.emoji_aliases }),
            ...(action.payload.unlisted !== undefined && { unlisted: action.payload.unlisted }),
            ...(action.payload.has_password !== undefined && { has_password: action.payload.has_password }),
            ...(action.payload.read_only !== undefined && { read_only: action.payload.read_only }),
            ...(action.payload.banner_url !== undefined && { banner_url: action.payload.banner_url }),
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
    case "SET_WS_CONNECTED":
      return { ...state, wsConnected: action.payload };
    case "UPDATE_MEMBER_ROLE":
      return {
        ...state,
        roomMembers: state.roomMembers.map((m) =>
          m.userId === action.payload.userId
            ? { ...m, role: action.payload.role }
            : m
        ),
      };
    case "UPDATE_NAME_COLORS": {
      const existing = state.roomInfoMap[action.payload.roomId];
      if (!existing) return state;
      return {
        ...state,
        roomInfoMap: {
          ...state.roomInfoMap,
          [action.payload.roomId]: {
            ...existing,
            owner_name_color: action.payload.owner_name_color,
            mod_name_color: action.payload.mod_name_color,
          },
        },
      };
    }
    case "SET_IS_ADMIN":
      return { ...state, isAdmin: action.payload };
    case "SET_ADMIN_DASHBOARD_OPEN":
      return { ...state, adminDashboardOpen: action.payload };
    case "SET_SERVER_SETTINGS":
      return { ...state, requireAuthForUploads: action.payload.requireAuthForUploads, uploadLimitBytes: action.payload.uploadLimitBytes, storageLimitBytes: action.payload.storageLimitBytes };
    case "SET_TOTP_VERIFIED":
      return { ...state, totpVerified: action.payload };
    case "SET_ROOM_GROUPS":
      return { ...state, roomGroups: action.payload };
    case "UPDATE_ROOM_GROUP":
      return {
        ...state,
        roomGroups: state.roomGroups.map((g) =>
          g.group_id === action.payload.group_id ? action.payload : g
        ),
      };
    case "REMOVE_ROOM_GROUP":
      return {
        ...state,
        roomGroups: state.roomGroups.filter((g) => g.group_id !== action.payload),
      };
    case "TOGGLE_GROUP_COLLAPSED":
      return {
        ...state,
        roomGroups: state.roomGroups.map((g) =>
          g.group_id === action.payload.groupId
            ? { ...g, collapsed: action.payload.collapsed }
            : g
        ),
      };
    case "SET_FRIENDS_DATA":
      return {
        ...state,
        friends: action.payload.friends,
        incomingFriendRequests: action.payload.incomingRequests,
        outgoingFriendRequests: action.payload.outgoingRequests,
        blockedUsers: action.payload.blocked,
      };
    case "ADD_FRIEND":
      return {
        ...state,
        friends: state.friends.includes(action.payload)
          ? state.friends
          : [...state.friends, action.payload],
      };
    case "REMOVE_FRIEND":
      return {
        ...state,
        friends: state.friends.filter((id) => id !== action.payload),
      };
    case "ADD_INCOMING_REQUEST":
      return {
        ...state,
        incomingFriendRequests: state.incomingFriendRequests.some((r) => r.userId === action.payload.userId)
          ? state.incomingFriendRequests
          : [...state.incomingFriendRequests, action.payload],
      };
    case "REMOVE_INCOMING_REQUEST":
      return {
        ...state,
        incomingFriendRequests: state.incomingFriendRequests.filter((r) => r.userId !== action.payload),
      };
    case "ADD_OUTGOING_REQUEST":
      return {
        ...state,
        outgoingFriendRequests: state.outgoingFriendRequests.some((r) => r.userId === action.payload.userId)
          ? state.outgoingFriendRequests
          : [...state.outgoingFriendRequests, action.payload],
      };
    case "REMOVE_OUTGOING_REQUEST":
      return {
        ...state,
        outgoingFriendRequests: state.outgoingFriendRequests.filter((r) => r.userId !== action.payload),
      };
    case "ADD_BLOCKED_USER":
      return {
        ...state,
        blockedUsers: state.blockedUsers.includes(action.payload)
          ? state.blockedUsers
          : [...state.blockedUsers, action.payload],
      };
    case "REMOVE_BLOCKED_USER":
      return {
        ...state,
        blockedUsers: state.blockedUsers.filter((id) => id !== action.payload),
      };
    case "SET_CUSTOM_ROLES":
      return { ...state, customRoles: action.payload };
    case "ADD_CUSTOM_ROLE":
      if (state.customRoles.some((r) => r.role_id === action.payload.role_id)) return state;
      return { ...state, customRoles: [...state.customRoles, action.payload] };
    case "UPDATE_CUSTOM_ROLE":
      return {
        ...state,
        customRoles: state.customRoles.map((r) =>
          r.role_id === action.payload.role_id ? { ...r, ...action.payload } : r
        ),
      };
    case "REMOVE_CUSTOM_ROLE":
      return {
        ...state,
        customRoles: state.customRoles.filter((r) => r.role_id !== action.payload),
      };
    case "SET_MEMBER_CUSTOM_ROLES":
      return { ...state, memberCustomRoles: action.payload };
    case "UPDATE_MEMBER_CUSTOM_ROLES":
      return {
        ...state,
        memberCustomRoles: { ...state.memberCustomRoles, [action.payload.userId]: action.payload.roleIds },
      };
    case "SET_CHANNELS":
      return { ...state, channels: action.payload };
    case "SET_CHANNEL_CATEGORIES":
      return { ...state, channelCategories: action.payload };
    case "ADD_CHANNEL_CATEGORY":
      if (state.channelCategories.some((c) => c.category_id === action.payload.category_id)) return state;
      return { ...state, channelCategories: [...state.channelCategories, action.payload] };
    case "UPDATE_CHANNEL_CATEGORY":
      return {
        ...state,
        channelCategories: state.channelCategories.map((c) =>
          c.category_id === action.payload.category_id ? { ...c, ...action.payload } : c
        ),
      };
    case "REMOVE_CHANNEL_CATEGORY":
      return {
        ...state,
        channelCategories: state.channelCategories.filter((c) => c.category_id !== action.payload),
        channels: state.channels.map((ch) =>
          ch.category_id === action.payload ? { ...ch, category_id: "" } : ch
        ),
      };
    case "SELECT_CHANNEL":
      return {
        ...state,
        currentChannelId: action.payload,
        messages: [],
        hasMoreMessages: false,
        oldestMessageIndex: null,
        loadingOlderMessages: false,
      };
    case "ADD_CHANNEL":
      if (state.channels.some((c) => c.channel_id === action.payload.channel_id)) return state;
      return { ...state, channels: [...state.channels, action.payload] };
    case "UPDATE_CHANNEL":
      return {
        ...state,
        channels: state.channels.map((c) =>
          c.channel_id === action.payload.channel_id
            ? { ...c, ...action.payload }
            : c
        ),
      };
    case "REMOVE_CHANNEL":
      return {
        ...state,
        channels: state.channels.filter((c) => c.channel_id !== action.payload),
        currentChannelId:
          state.currentChannelId === action.payload ? null : state.currentChannelId,
      };
    case "SET_VOICE_CHANNEL_MEMBERS":
      return { ...state, voiceChannelMembers: action.payload };
    case "SET_VOICE_CHANNEL":
      return {
        ...state,
        voiceChannelMembers: {
          ...state.voiceChannelMembers,
          [action.payload.channelId]: action.payload.members,
        },
      };
    case "SET_VOICE_CHANNEL_OCCUPIED_SINCE":
      return { ...state, voiceChannelOccupiedSince: action.payload };
    case "UPDATE_VOICE_CHANNEL_OCCUPIED_SINCE": {
      if (action.payload.since == null) {
        const next = { ...state.voiceChannelOccupiedSince };
        delete next[action.payload.channelId];
        return { ...state, voiceChannelOccupiedSince: next };
      }
      return {
        ...state,
        voiceChannelOccupiedSince: {
          ...state.voiceChannelOccupiedSince,
          [action.payload.channelId]: action.payload.since,
        },
      };
    }
    case "SET_CHANNEL_MENTION":
      return {
        ...state,
        channelMentions: {
          ...state.channelMentions,
          [action.payload.channelId]: action.payload.hasMention
            ? (state.channelMentions[action.payload.channelId] || 0) + 1
            : 0,
        },
      };
    case "INCREMENT_CHANNEL_UNREAD":
      return {
        ...state,
        channelUnreadCounts: {
          ...state.channelUnreadCounts,
          [action.payload]: (state.channelUnreadCounts[action.payload] || 0) + 1,
        },
      };
    case "CLEAR_CHANNEL_UNREAD":
      return {
        ...state,
        channelUnreadCounts: { ...state.channelUnreadCounts, [action.payload]: 0 },
        channelMentions: { ...state.channelMentions, [action.payload]: 0 },
      };
    case "INCREMENT_ROOM_UNREAD":
      return {
        ...state,
        roomUnreadCounts: {
          ...state.roomUnreadCounts,
          [action.payload]: (state.roomUnreadCounts[action.payload] || 0) + 1,
        },
      };
    case "CLEAR_ROOM_UNREAD":
      return {
        ...state,
        roomUnreadCounts: { ...state.roomUnreadCounts, [action.payload]: 0 },
      };
    case "UPDATE_DM_STREAK": {
      const existing = state.roomInfoMap[action.payload.roomId];
      if (!existing) return state;
      return {
        ...state,
        roomInfoMap: {
          ...state.roomInfoMap,
          [action.payload.roomId]: {
            ...existing,
            dm_streak_count: action.payload.streakCount,
            dm_streak_last_ts: action.payload.lastMessageTs,
          },
        },
      };
    }
    default:
      return state;
  }
}
