import { describe, it, expect } from "vitest";
import {
  parseStoredVoiceSession,
  VOICE_SESSION_TTL_MS,
  decideVoiceRejoin,
  VOICE_REJOIN_GRACE_MS,
} from "@/lib/voiceRejoin";

const inCall = { inVoiceChannel: true, voiceRoomId: "!room:local" };

describe("decideVoiceRejoin", () => {
  it("puts a brief drop back together", () => {
    expect(decideVoiceRejoin({ ...inCall, downForMs: 0 })).toBe("rejoin");
    expect(decideVoiceRejoin({ ...inCall, downForMs: 3_000 })).toBe("rejoin");
  });

  it("treats the grace period itself as still a blip", () => {
    expect(decideVoiceRejoin({ ...inCall, downForMs: VOICE_REJOIN_GRACE_MS })).toBe(
      "rejoin",
    );
    expect(
      decideVoiceRejoin({ ...inCall, downForMs: VOICE_REJOIN_GRACE_MS + 1 }),
    ).toBe("release");
  });

  it("does not put someone back after a long absence", () => {
    expect(decideVoiceRejoin({ ...inCall, downForMs: 5 * 60_000 })).toBe("release");
  });

  it("has nothing to restore for someone who was not in a call", () => {
    expect(
      decideVoiceRejoin({ inVoiceChannel: false, voiceRoomId: null, downForMs: 0 }),
    ).toBe("nothing-to-restore");
    // Left deliberately while the socket was down: the flag is still set but
    // the room is gone, and a long absence must not turn that into a rejoin.
    expect(
      decideVoiceRejoin({ inVoiceChannel: true, voiceRoomId: null, downForMs: 0 }),
    ).toBe("nothing-to-restore");
  });
});

describe("parseStoredVoiceSession", () => {
  const session = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      roomId: "!room:localhost",
      channelId: "!voice:localhost",
      muted: true,
      deafened: false,
      timestamp: 1_000,
      ...over,
    });

  it("restores the call with the mute and deafen it was left in", () => {
    expect(parseStoredVoiceSession(session(), 1_000)).toEqual({
      roomId: "!room:localhost",
      channelId: "!voice:localhost",
      muted: true,
      deafened: false,
      timestamp: 1_000,
    });
  });

  it("carries deafen back too", () => {
    const parsed = parseStoredVoiceSession(session({ deafened: true }), 1_000);
    expect(parsed?.deafened).toBe(true);
  });

  it("treats a session with no mute recorded as unmuted", () => {
    // Entries written before mute was persisted; they expire within the TTL,
    // so this only covers the moments either side of an upgrade.
    const parsed = parseStoredVoiceSession(
      JSON.stringify({ roomId: "!room:localhost", channelId: null, timestamp: 1_000 }),
      1_000,
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.muted).toBe(false);
    expect(parsed?.deafened).toBe(false);
  });

  it("keeps a session that is exactly at the age limit", () => {
    expect(parseStoredVoiceSession(session(), 1_000 + VOICE_SESSION_TTL_MS)).not.toBeNull();
  });

  it("drops a session past the age limit", () => {
    expect(parseStoredVoiceSession(session(), 1_001 + VOICE_SESSION_TTL_MS)).toBeNull();
  });

  it("drops nothing, junk, and entries missing a room", () => {
    expect(parseStoredVoiceSession(null, 1_000)).toBeNull();
    expect(parseStoredVoiceSession("not json", 1_000)).toBeNull();
    expect(parseStoredVoiceSession("[]", 1_000)).toBeNull();
    expect(parseStoredVoiceSession(session({ roomId: "" }), 1_000)).toBeNull();
    expect(parseStoredVoiceSession(session({ timestamp: "soon" }), 1_000)).toBeNull();
  });

  it("accepts a call that was in no particular channel", () => {
    expect(parseStoredVoiceSession(session({ channelId: null }), 1_000)?.channelId).toBeNull();
  });
});
