/**
 * @vitest-environment jsdom
 *
 * Needs a DOM for localStorage; the resolution rules themselves are pure.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  arrivalSound,
  DEFAULT_SOUND_SETTINGS,
  loadSoundSettings,
  resolveSound,
  saveSoundSettings,
  type SoundPack,
} from "@/lib/sounds";

beforeEach(() => {
  localStorage.clear();
});

describe("resolveSound", () => {
  it("falls back to the built-in sound with no pack", () => {
    expect(resolveSound("mention")).toBe("/external/vc-join.wav");
    expect(resolveSound("mute")).toBe("/external/mute.wav");
  });

  it("prefers a room's override", () => {
    const pack: SoundPack = { mention: "/external/uploads/u1/ping.wav" };
    expect(resolveSound("mention", pack)).toBe("/external/uploads/u1/ping.wav");
  });

  it("falls back per event, so a partial pack is not a broken one", () => {
    const pack: SoundPack = { mention: "/external/uploads/u1/ping.wav" };
    expect(resolveSound("mute", pack)).toBe("/external/mute.wav");
  });

  it("treats a blank override as no override", () => {
    // Clearing a pack entry stores nothing server-side, but a stale client
    // could still hold an empty string.
    const pack: SoundPack = { mention: "   " };
    expect(resolveSound("mention", pack)).toBe("/external/vc-join.wav");
  });

  it("signals the derived leave sound with null", () => {
    // The built-in leave sound is the join sound reversed at runtime, so it
    // has no URL of its own.
    expect(resolveSound("voice-leave")).toBeNull();
  });

  it("uses a pack's leave sound instead of deriving one", () => {
    const pack: SoundPack = { "voice-leave": "/external/uploads/u1/bye.wav" };
    expect(resolveSound("voice-leave", pack)).toBe("/external/uploads/u1/bye.wav");
  });
});

describe("sound settings", () => {
  it("defaults when nothing is stored", () => {
    expect(loadSoundSettings()).toEqual(DEFAULT_SOUND_SETTINGS);
  });

  it("round-trips a saved setting", () => {
    saveSoundSettings({ enabled: false, volume: 0.25 });
    expect(loadSoundSettings()).toEqual({ enabled: false, volume: 0.25 });
  });

  it("clamps a volume outside the usable range", () => {
    // Neither silent-forever nor painfully loud should be reachable, since
    // neither is recoverable from without finding the slider again.
    saveSoundSettings({ enabled: true, volume: 5 });
    expect(loadSoundSettings().volume).toBe(1);
    saveSoundSettings({ enabled: true, volume: -3 });
    expect(loadSoundSettings().volume).toBe(0);
  });

  it("falls back to the default volume for a non-finite value", () => {
    localStorage.setItem(
      "chatter_sound_settings",
      JSON.stringify({ enabled: true, volume: null }),
    );
    expect(loadSoundSettings().volume).toBe(DEFAULT_SOUND_SETTINGS.volume);
  });

  it("survives corrupt stored JSON", () => {
    localStorage.setItem("chatter_sound_settings", "not json");
    expect(loadSoundSettings()).toEqual(DEFAULT_SOUND_SETTINGS);
  });

  it("keeps the other field when only one was stored", () => {
    localStorage.setItem("chatter_sound_settings", JSON.stringify({ enabled: false }));
    const settings = loadSoundSettings();
    expect(settings.enabled).toBe(false);
    expect(settings.volume).toBe(DEFAULT_SOUND_SETTINGS.volume);
  });
});

describe("arrivalSound", () => {
  const pack: SoundPack = { "voice-join": "/external/uploads/room/fanfare.wav" };
  const sting = "/external/uploads/u1/my-sting.wav";

  it("plays a member's own sting over the room's pack", () => {
    // The point of the rule: a room replacing the generic join sound must not
    // decide what one of its members sounds like when they arrive.
    expect(arrivalSound(sting, pack)).toEqual({ url: sting, gain: 1 });
  });

  it("plays the room's pack for someone with no sting of their own", () => {
    expect(arrivalSound(undefined, pack)?.url).toBe(
      "/external/uploads/room/fanfare.wav",
    );
    expect(arrivalSound("", pack)?.url).toBe("/external/uploads/room/fanfare.wav");
    expect(arrivalSound("   ", pack)?.url).toBe("/external/uploads/room/fanfare.wav");
  });

  it("falls back to the built-in join sound with neither", () => {
    expect(arrivalSound(undefined)?.url).toBe("/external/vc-join.wav");
  });

  it("plays a sting even where the room has no pack", () => {
    expect(arrivalSound(sting)).toEqual({ url: sting, gain: 1 });
  });

  it("answers with one sound, never a sting and a pack together", () => {
    // An arrival makes a single noise; the shape of the answer is what
    // guarantees it, since there is nowhere to put a second url.
    const result = arrivalSound(sting, pack);
    expect(result).not.toBeNull();
    expect(Object.keys(result!).sort()).toEqual(["gain", "url"]);
  });
});
