import { describe, it, expect } from "vitest";
import { reducer } from "@/lib/store/reducer";
import { initialState } from "@/lib/store/types";
import type { AppState, VoiceChannelMember } from "@/lib/store/types";

const ROOM = "!room:localhost";
const OTHER_ROOM = "!other:localhost";
const GENERAL = "!general-voice:localhost";
const GAMING = "!gaming-voice:localhost";

const member = (
  userId: string,
  overrides: Partial<VoiceChannelMember> = {},
): VoiceChannelMember => ({
  userId,
  muted: false,
  deafened: false,
  screen_sharing: false,
  ...overrides,
});

/** A client looking at one room, with a call running in each of two rooms. */
const watchingTwoCalls = (): AppState => ({
  ...initialState,
  currentRoomId: ROOM,
  voiceChannelMembers: {
    [GENERAL]: [member("@ada:localhost", { muted: true })],
    [GAMING]: [member("@grace:localhost")],
  },
  voiceChannelRooms: { [GENERAL]: ROOM, [GAMING]: OTHER_ROOM },
});

describe("the voice state snapshot", () => {
  it("replaces every room when the server describes them all", () => {
    const next = reducer(watchingTwoCalls(), {
      type: "SYNC_VOICE_STATE",
      payload: {
        roomId: null,
        channels: {
          [GAMING]: {
            roomId: OTHER_ROOM,
            occupiedSince: 1000,
            members: [member("@grace:localhost", { deafened: true })],
          },
        },
      },
    });

    // The snapshot did not name #general, so its call has ended.
    expect(next.voiceChannelMembers[GENERAL]).toBeUndefined();
    expect(next.voiceChannelMembers[GAMING]).toEqual([
      member("@grace:localhost", { deafened: true }),
    ]);
    expect(next.voiceChannelOccupiedSince[GAMING]).toBe(1000);
  });

  it("leaves other rooms alone when it only covers one", () => {
    // The REST endpoint is asked about a single room and knows nothing about
    // the others; reading its silence as "empty" would end calls it never saw.
    const next = reducer(watchingTwoCalls(), {
      type: "SYNC_VOICE_STATE",
      payload: { roomId: ROOM, channels: {} },
    });

    expect(next.voiceChannelMembers[GENERAL]).toBeUndefined();
    expect(next.voiceChannelMembers[GAMING]).toHaveLength(1);
  });

  it("derives the flat member list for the room on screen", () => {
    const next = reducer(watchingTwoCalls(), {
      type: "SYNC_VOICE_STATE",
      payload: {
        roomId: null,
        channels: {
          [GENERAL]: {
            roomId: ROOM,
            occupiedSince: null,
            members: [
              member("@ada:localhost", { muted: true }),
              member("@bob:localhost", { screen_sharing: true }),
            ],
          },
          [GAMING]: {
            roomId: OTHER_ROOM,
            occupiedSince: null,
            members: [member("@grace:localhost")],
          },
        },
      },
    });

    expect(next.voiceMembers).toEqual(["@ada:localhost", "@bob:localhost"]);
    expect(next.voiceMemberStates["@ada:localhost"].muted).toBe(true);
    expect(next.activeScreenSharers).toEqual(["@bob:localhost"]);
  });

  it("follows the call this client is in, not the room it is reading", () => {
    const inACallElsewhere: AppState = {
      ...watchingTwoCalls(),
      inVoiceChannel: true,
      voiceRoomId: OTHER_ROOM,
      voiceChannelId: GAMING,
    };

    const next = reducer(inACallElsewhere, {
      type: "SET_VOICE_CHANNEL",
      payload: {
        channelId: GAMING,
        roomId: OTHER_ROOM,
        members: [member("@grace:localhost"), member("@me:localhost")],
      },
    });

    expect(next.voiceMembers).toEqual(["@grace:localhost", "@me:localhost"]);
  });
});

describe("a room switch", () => {
  it("keeps the calls running in every other room", () => {
    // The map used to be cleared here, so the room being opened showed empty
    // voice channels until something happened to refetch them.
    const next = reducer(watchingTwoCalls(), {
      type: "SELECT_ROOM",
      payload: OTHER_ROOM,
    });

    expect(next.voiceChannelMembers[GENERAL]).toHaveLength(1);
    expect(next.voiceChannelMembers[GAMING]).toHaveLength(1);
    expect(next.voiceMembers).toEqual(["@grace:localhost"]);
  });
});

describe("a channel emptying", () => {
  it("is removed rather than left as an empty list", () => {
    const next = reducer(watchingTwoCalls(), {
      type: "SET_VOICE_CHANNEL",
      payload: { channelId: GENERAL, roomId: ROOM, members: [] },
    });

    expect(next.voiceChannelMembers[GENERAL]).toBeUndefined();
    expect(next.voiceChannelRooms[GENERAL]).toBeUndefined();
    expect(next.voiceMembers).toEqual([]);
  });
});
