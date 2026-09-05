import { describe, it, expect, beforeEach } from "vitest";
import {
  CLIP_LENGTH_OPTIONS,
  DEFAULT_CLIP_SETTINGS,
  loadClipSettings,
  storeClipSettings,
} from "@/hooks/useClipSettings";

const STORAGE_KEY = "chatter_clip_settings";
const LEGACY_LENGTH_KEY = "chatter_clip_length_secs";

/** Enough of the two browser globals the module touches. */
function installBrowserStubs(): Map<string, string> {
  const store = new Map<string, string>();
  const localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: localStorage,
    configurable: true,
  });
  Object.defineProperty(globalThis, "window", {
    value: { dispatchEvent: () => true },
    configurable: true,
  });
  return store;
}

describe("loadClipSettings", () => {
  let store: Map<string, string>;
  beforeEach(() => {
    store = installBrowserStubs();
  });

  it("returns the defaults when nothing is stored", () => {
    expect(loadClipSettings()).toEqual(DEFAULT_CLIP_SETTINGS);
  });

  it("leaves auto-arm off by default — it costs a second encoder", () => {
    expect(DEFAULT_CLIP_SETTINGS.autoArm).toBe(false);
  });

  it("round-trips what was saved", () => {
    storeClipSettings({ autoArm: true, lengthSecs: 60 });
    expect(loadClipSettings()).toEqual({ autoArm: true, lengthSecs: 60 });
  });

  it("carries over a length saved under the superseded key", () => {
    store.set(LEGACY_LENGTH_KEY, "15");
    expect(loadClipSettings()).toEqual({ autoArm: false, lengthSecs: 15 });
  });

  it("prefers the current key over the superseded one", () => {
    store.set(LEGACY_LENGTH_KEY, "15");
    storeClipSettings({ autoArm: true, lengthSecs: 60 });
    expect(loadClipSettings().lengthSecs).toBe(60);
  });

  it("falls back to the default length for a value not on the menu", () => {
    // A hand-edited or stale entry must not reach the recorder as a rotation
    // interval, where it would set how much footage a clip actually holds.
    store.set(STORAGE_KEY, JSON.stringify({ autoArm: true, lengthSecs: 3600 }));
    const settings = loadClipSettings();
    expect(settings.lengthSecs).toBe(DEFAULT_CLIP_SETTINGS.lengthSecs);
    expect(settings.autoArm).toBe(true);
    expect(CLIP_LENGTH_OPTIONS).toContain(settings.lengthSecs);
  });

  it("treats a non-boolean auto-arm as off rather than truthy", () => {
    store.set(STORAGE_KEY, JSON.stringify({ autoArm: "yes", lengthSecs: 30 }));
    expect(loadClipSettings().autoArm).toBe(false);
  });

  it("survives unparseable storage", () => {
    store.set(STORAGE_KEY, "{not json");
    expect(loadClipSettings()).toEqual(DEFAULT_CLIP_SETTINGS);
  });
});
