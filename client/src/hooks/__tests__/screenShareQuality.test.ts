import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getScreenSharePublishProfile,
  loadScreenShareFps,
  storeScreenShareFps,
  SCREEN_FPS_STORAGE_KEY,
} from "@/lib/webrtc";

describe("Screen share quality configuration", () => {
  describe("30fps profile", () => {
    const profile = getScreenSharePublishProfile(30);

    it("uses motion contentHint", () => {
      expect(profile.contentHint).toBe("motion");
    });

    it("has 8 Mbps max bitrate", () => {
      expect(profile.maxBitrateBps).toBe(8_000_000);
    });

    it("targets 30fps", () => {
      expect(profile.targetFps).toBe(30);
    });
  });

  describe("60fps profile", () => {
    const profile = getScreenSharePublishProfile(60);

    it("has 12 Mbps max bitrate", () => {
      expect(profile.maxBitrateBps).toBe(12_000_000);
    });

    it("targets 60fps", () => {
      expect(profile.targetFps).toBe(60);
    });
  });
});

describe("Screen share fps preference persistence", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

  function installStorage(impl: Partial<Storage>) {
    Object.defineProperty(globalThis, "localStorage", {
      value: impl,
      configurable: true,
      writable: true,
    });
  }

  beforeEach(() => {
    const store = new Map<string, string>();
    installStorage({
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });

  afterEach(() => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });

  it("defaults to 30 when nothing is stored", () => {
    expect(loadScreenShareFps()).toBe(30);
  });

  it("round-trips a 60fps choice", () => {
    storeScreenShareFps(60);
    expect(localStorage.getItem(SCREEN_FPS_STORAGE_KEY)).toBe("60");
    expect(loadScreenShareFps()).toBe(60);
  });

  it("round-trips a 30fps choice", () => {
    storeScreenShareFps(60);
    storeScreenShareFps(30);
    expect(loadScreenShareFps()).toBe(30);
  });

  it("falls back to 30 for an unrecognised stored value", () => {
    localStorage.setItem(SCREEN_FPS_STORAGE_KEY, "144");
    expect(loadScreenShareFps()).toBe(30);
  });

  it("survives storage that throws, as in private mode", () => {
    installStorage({
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    });
    expect(loadScreenShareFps()).toBe(30);
    expect(() => storeScreenShareFps(60)).not.toThrow();
  });
});
