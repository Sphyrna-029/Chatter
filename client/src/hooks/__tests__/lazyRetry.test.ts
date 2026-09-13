import { describe, it, expect, vi } from "vitest";
import { isChunkLoadError, loadWithRetry } from "@/lib/lazyRetry";

/** Never actually waits — the backoff is not what is under test. */
const noSleep = () => Promise.resolve();

describe("telling a view that would not load from one that threw", () => {
  it("recognises what each engine says about a dead chunk", () => {
    // The messages themselves, because this is the only thing standing between
    // "reload, the build moved" and "this is a bug, reloading reproduces it".
    const messages = [
      // Chrome, Edge
      "Failed to fetch dynamically imported module: https://chat/assets/ForumArea-a1b2c3.js",
      // Firefox
      "error loading dynamically imported module",
      // Safari
      "Importing a module script failed.",
      // Vite's preload helper
      "Unable to preload CSS for /assets/ForumArea-a1b2c3.css",
    ];
    for (const message of messages) {
      expect(isChunkLoadError(new TypeError(message))).toBe(true);
    }
  });

  it("does not mistake an ordinary crash for a stale build", () => {
    // The costly direction: offering "reload" for a real bug sends someone
    // round a loop that reproduces it every time.
    expect(isChunkLoadError(new TypeError("x is not a function"))).toBe(false);
    expect(isChunkLoadError(new Error("Cannot read properties of undefined"))).toBe(false);
  });

  it("survives being handed something that is not an error", () => {
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
    expect(isChunkLoadError({})).toBe(false);
    expect(isChunkLoadError({ message: 42 })).toBe(false);
    expect(isChunkLoadError("Failed to fetch dynamically imported module")).toBe(true);
  });
});

describe("loading a split view", () => {
  it("does not retry what worked", async () => {
    const load = vi.fn().mockResolvedValue({ default: "view" });
    await expect(loadWithRetry(load, { sleep: noSleep })).resolves.toEqual({
      default: "view",
    });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("gives a dropped request a second go", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch dynamically imported module"))
      .mockResolvedValue({ default: "view" });

    await expect(loadWithRetry(load, { sleep: noSleep })).resolves.toEqual({
      default: "view",
    });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("rethrows the last failure once the tries are spent", async () => {
    // It has to reach the boundary: a view that silently resolves to nothing
    // would leave an empty pane with no way back.
    const fatal = new TypeError("Failed to fetch dynamically imported module");
    const load = vi.fn().mockRejectedValue(fatal);

    await expect(loadWithRetry(load, { sleep: noSleep })).rejects.toBe(fatal);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("honours a longer run of attempts", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("one"))
      .mockRejectedValueOnce(new Error("two"))
      .mockResolvedValue({ default: "view" });

    await expect(
      loadWithRetry(load, { attempts: 3, sleep: noSleep }),
    ).resolves.toEqual({ default: "view" });
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("backs off further with each attempt", async () => {
    const waits: number[] = [];
    const load = vi.fn().mockRejectedValue(new Error("no"));

    await expect(
      loadWithRetry(load, {
        attempts: 3,
        delayMs: 100,
        sleep: (ms) => {
          waits.push(ms);
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow("no");

    // One wait per gap between attempts, never after the last.
    expect(waits).toEqual([100, 200]);
  });
});
