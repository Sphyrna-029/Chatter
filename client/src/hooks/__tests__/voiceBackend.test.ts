/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// lib/desktop/bridge reads window.chatterDesktop once, at import, so each case
// installs its bridge first and imports a fresh copy of the modules.
async function load(bridge: unknown) {
  vi.resetModules();
  (window as unknown as { chatterDesktop?: unknown }).chatterDesktop = bridge;
  return import("@/lib/media");
}

const fakeNative = { kind: "native" } as const;

afterEach(() => {
  delete (window as unknown as { chatterDesktop?: unknown }).chatterDesktop;
  localStorage.clear();
});

describe("selectVoiceBackend", () => {
  it("uses the browser's stack in a browser", async () => {
    const media = await load(undefined);
    expect(media.nativeVoiceAvailable()).toBe(false);
    expect(media.selectVoiceBackend()).toBe(media.browserVoiceBackend);
  });

  it("uses the desktop engine when the app offers one", async () => {
    const voiceBackend = vi.fn(() => fakeNative);
    const media = await load({ features: ["voice-backend@1"], voiceBackend });
    expect(media.selectVoiceBackend()).toBe(fakeNative);
    expect(voiceBackend).toHaveBeenCalledWith(1);
  });

  it("ignores a voiceBackend the app doesn't advertise", async () => {
    const media = await load({ features: [], voiceBackend: () => fakeNative });
    expect(media.selectVoiceBackend()).toBe(media.browserVoiceBackend);
  });

  it("stays on the browser when the person switched native voice off", async () => {
    const media = await load({ features: ["voice-backend@1"], voiceBackend: () => fakeNative });
    media.setNativeVoicePreferred(false);
    expect(media.selectVoiceBackend()).toBe(media.browserVoiceBackend);
    media.setNativeVoicePreferred(true);
    expect(media.selectVoiceBackend()).toBe(fakeNative);
  });

  it("falls back to the browser when the engine can't start", async () => {
    const throwing = await load({
      features: ["voice-backend@1"],
      voiceBackend: () => {
        throw new Error("engine gone");
      },
    });
    expect(throwing.selectVoiceBackend()).toBe(throwing.browserVoiceBackend);

    const empty = await load({ features: ["voice-backend@1"], voiceBackend: () => null });
    expect(empty.selectVoiceBackend()).toBe(empty.browserVoiceBackend);
  });
});
