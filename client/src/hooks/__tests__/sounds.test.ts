/**
 * @vitest-environment jsdom
 *
 * Needs a DOM for localStorage; the resolution rules themselves are pure.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
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
