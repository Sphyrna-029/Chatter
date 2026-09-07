import { describe, it, expect } from "vitest";
import {
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
