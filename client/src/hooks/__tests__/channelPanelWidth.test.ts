/**
 * The channel column's stored width.
 *
 * The rule worth pinning is the difference between "never chosen" and "chosen":
 * the column measures itself per room only while nothing is stored, so a
 * `null` that should have been a number is a width the reader set and the app
 * then overrode on the next room change.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  DEFAULT_PANEL_WIDTH,
  MAX_PANEL_WIDTH,
  MIN_DRAG_WIDTH,
  chosenChannelPanelWidth,
  clampPanelWidth,
  forgetChosenChannelPanelWidth,
  loadChannelPanelWidth,
  storeChannelPanelWidth,
} from "@/lib/channelPanelWidth";

const STORAGE_KEY = "chatter_channel_panel_width";

/** Enough of `localStorage` for the module to talk to. */
function installStorage(): Map<string, string> {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
    configurable: true,
  });
  return store;
}

/** A storage that refuses, as a browser in private mode can. */
function installRefusingStorage(): void {
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {},
    },
    configurable: true,
  });
}

describe("clampPanelWidth", () => {
  it("holds a width to the draggable range", () => {
    expect(clampPanelWidth(10)).toBe(MIN_DRAG_WIDTH);
    expect(clampPanelWidth(9999)).toBe(MAX_PANEL_WIDTH);
    expect(clampPanelWidth(260.4)).toBe(260);
  });

  it("answers with the default for a width that is not a number", () => {
    expect(clampPanelWidth(Number.NaN)).toBe(DEFAULT_PANEL_WIDTH);
    expect(clampPanelWidth(Number.POSITIVE_INFINITY)).toBe(DEFAULT_PANEL_WIDTH);
  });
});

describe("loadChannelPanelWidth", () => {
  let store: Map<string, string>;
  beforeEach(() => {
    store = installStorage();
    forgetChosenChannelPanelWidth();
  });

  it("is null when the reader has never chosen one", () => {
    // Null rather than the default: it is what lets the column go on
    // measuring itself per room, which is what an untouched handle means.
    expect(loadChannelPanelWidth()).toBeNull();
  });

  it("reads back a width that was stored", () => {
    storeChannelPanelWidth(260);
    expect(loadChannelPanelWidth()).toBe(260);
    expect(store.get(STORAGE_KEY)).toBe("260");
  });

  it("holds a stored width to the range it is read under", () => {
    // The limits can move between releases and a stored width outlives them.
    store.set(STORAGE_KEY, "5000");
    expect(loadChannelPanelWidth()).toBe(MAX_PANEL_WIDTH);
    store.set(STORAGE_KEY, "12");
    expect(loadChannelPanelWidth()).toBe(MIN_DRAG_WIDTH);
  });

  it("treats nonsense as never chosen", () => {
    store.set(STORAGE_KEY, "wide please");
    expect(loadChannelPanelWidth()).toBeNull();
    store.set(STORAGE_KEY, "0");
    expect(loadChannelPanelWidth()).toBeNull();
    store.set(STORAGE_KEY, "-40");
    expect(loadChannelPanelWidth()).toBeNull();
  });

  it("stores a dragged width rounded and clamped", () => {
    storeChannelPanelWidth(137.6);
    expect(store.get(STORAGE_KEY)).toBe(String(MIN_DRAG_WIDTH));
  });
});

describe("chosenChannelPanelWidth", () => {
  let store: Map<string, string>;
  beforeEach(() => {
    store = installStorage();
    forgetChosenChannelPanelWidth();
  });

  it("reads storage once and holds the answer", () => {
    // The column asks this on every render and is rebuilt on every room
    // change, so the answer cannot depend on a fresh read each time.
    store.set(STORAGE_KEY, "300");
    expect(chosenChannelPanelWidth()).toBe(300);
    store.set(STORAGE_KEY, "180");
    expect(chosenChannelPanelWidth()).toBe(300);
  });

  it("takes a newly dragged width without waiting for a read", () => {
    expect(chosenChannelPanelWidth()).toBeNull();
    storeChannelPanelWidth(260);
    expect(chosenChannelPanelWidth()).toBe(260);
  });
});

describe("with storage refused", () => {
  beforeEach(() => {
    installRefusingStorage();
    forgetChosenChannelPanelWidth();
  });

  it("reads as never chosen rather than throwing", () => {
    expect(loadChannelPanelWidth()).toBeNull();
  });

  it("swallows a write that cannot be made, and still holds the width", () => {
    // The drag lasts the session rather than the room: the column is rebuilt
    // on every room change and asks again each time.
    expect(() => storeChannelPanelWidth(300)).not.toThrow();
    expect(chosenChannelPanelWidth()).toBe(300);
  });
});
