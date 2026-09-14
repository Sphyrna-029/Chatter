import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getScreenSharePublishProfile,
  loadScreenShareFps,
  storeScreenShareFps,
  SCREEN_FPS_STORAGE_KEY,
  SCREEN_BITRATE_STORAGE_KEY,
  SCREEN_BITRATE_MIN_BPS,
  SCREEN_BITRATE_MAX_BPS,
  SCREEN_CONTENT_STORAGE_KEY,
  SCREEN_MAX_WIDTH,
  SCREEN_MAX_HEIGHT,
  loadScreenContentMode,
  storeScreenContentMode,
  orderVideoCodecs,
  clampScreenShareBitrate,
  defaultScreenShareBitrate,
  formatScreenBitrate,
  loadScreenShareBitrate,
  storeScreenShareBitrate,
} from "@/lib/webrtc";

describe("Screen share quality configuration", () => {
  describe("30fps profile", () => {
    const profile = getScreenSharePublishProfile(30);

    it("protects detail by default, which is what a screen usually holds", () => {
      // Both profiles used to say "motion" unconditionally, so text went soft
      // during every scroll and no bitrate could fix it.
      expect(profile.contentHint).toBe("detail");
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

describe("the screen share bitrate ceiling", () => {
  it("keeps what the frame rate used to imply as the untouched default", () => {
    // The point of these two numbers: making the bitrate adjustable must not
    // quietly move anybody's existing share.
    expect(defaultScreenShareBitrate(30)).toBe(8_000_000);
    expect(defaultScreenShareBitrate(60)).toBe(12_000_000);
  });

  it("builds a profile at the requested ceiling", () => {
    expect(getScreenSharePublishProfile(30, 3_000_000).maxBitrateBps).toBe(3_000_000);
    expect(getScreenSharePublishProfile(60, 3_000_000).maxBitrateBps).toBe(3_000_000);
    // The frame rate is still its own setting.
    expect(getScreenSharePublishProfile(60, 3_000_000).targetFps).toBe(60);
  });

  it("falls back to the frame rate's default when given no ceiling", () => {
    expect(getScreenSharePublishProfile(30).maxBitrateBps).toBe(8_000_000);
    expect(getScreenSharePublishProfile(60).maxBitrateBps).toBe(12_000_000);
  });

  describe("clamping", () => {
    const fallback = 8_000_000;

    it("holds a value inside the range", () => {
      expect(clampScreenShareBitrate(5_000_000, fallback)).toBe(5_000_000);
    });

    it("pulls an out-of-range value to the nearest bound", () => {
      expect(clampScreenShareBitrate(1, fallback)).toBe(SCREEN_BITRATE_MIN_BPS);
      expect(clampScreenShareBitrate(999_000_000, fallback)).toBe(SCREEN_BITRATE_MAX_BPS);
    });

    it("reads a stored string, since that is what localStorage returns", () => {
      expect(clampScreenShareBitrate("5000000", fallback)).toBe(5_000_000);
    });

    it("falls back rather than encoding at NaN", () => {
      // A bad value reaching setParameters is the failure worth avoiding: it
      // is accepted and then the share sends nothing.
      expect(clampScreenShareBitrate("nonsense", fallback)).toBe(fallback);
      expect(clampScreenShareBitrate(Number.NaN, fallback)).toBe(fallback);
      expect(clampScreenShareBitrate(Number.POSITIVE_INFINITY, fallback)).toBe(fallback);
      expect(clampScreenShareBitrate(null, fallback)).toBe(fallback);
      expect(clampScreenShareBitrate(undefined, fallback)).toBe(fallback);
    });
  });

  describe("persistence", () => {
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

    it("tracks the frame rate until somebody chooses a value", () => {
      expect(loadScreenShareBitrate(30)).toBe(8_000_000);
      expect(loadScreenShareBitrate(60)).toBe(12_000_000);
    });

    it("stops tracking the frame rate once a value is chosen", () => {
      // Otherwise a deliberate 3 Mbps would jump back to 12 on switching to
      // 60fps — exactly what somebody on a thin uplink set it to avoid.
      storeScreenShareBitrate(3_000_000);
      expect(loadScreenShareBitrate(30)).toBe(3_000_000);
      expect(loadScreenShareBitrate(60)).toBe(3_000_000);
    });

    it("round-trips a choice", () => {
      storeScreenShareBitrate(6_500_000);
      expect(localStorage.getItem(SCREEN_BITRATE_STORAGE_KEY)).toBe("6500000");
      expect(loadScreenShareBitrate(30)).toBe(6_500_000);
    });

    it("clamps whatever it finds stored", () => {
      localStorage.setItem(SCREEN_BITRATE_STORAGE_KEY, "999000000");
      expect(loadScreenShareBitrate(30)).toBe(SCREEN_BITRATE_MAX_BPS);
      localStorage.setItem(SCREEN_BITRATE_STORAGE_KEY, "banana");
      expect(loadScreenShareBitrate(30)).toBe(8_000_000);
    });

    it("survives storage that throws, as in private mode", () => {
      installStorage({
        getItem: () => { throw new Error("blocked"); },
        setItem: () => { throw new Error("blocked"); },
      });
      expect(loadScreenShareBitrate(60)).toBe(12_000_000);
      expect(() => storeScreenShareBitrate(4_000_000)).not.toThrow();
    });
  });

  describe("how it reads", () => {
    it("drops the decimal on a round number", () => {
      expect(formatScreenBitrate(8_000_000)).toBe("8 Mbps");
      expect(formatScreenBitrate(12_000_000)).toBe("12 Mbps");
    });

    it("keeps one decimal on a half step", () => {
      expect(formatScreenBitrate(6_500_000)).toBe("6.5 Mbps");
      expect(formatScreenBitrate(1_500_000)).toBe("1.5 Mbps");
    });
  });
});

describe("what the encoder is told to protect", () => {
  it("pairs the hint with what degrades first", () => {
    // Saying "motion" while preferring resolution asks for both and gets a
    // muddle, which is what the fixed pair replaced.
    const detail = getScreenSharePublishProfile(30, 8_000_000, "detail");
    expect(detail.contentHint).toBe("detail");
    expect(detail.degradationPreference).toBe("maintain-resolution");

    const motion = getScreenSharePublishProfile(60, 8_000_000, "motion");
    expect(motion.contentHint).toBe("motion");
    expect(motion.degradationPreference).toBe("maintain-framerate");
  });

  it("defaults to detail when nothing says otherwise", () => {
    expect(getScreenSharePublishProfile(60, 8_000_000).contentHint).toBe("detail");
  });

  describe("persistence", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

    beforeEach(() => {
      const store = new Map<string, string>();
      Object.defineProperty(globalThis, "localStorage", {
        value: {
          getItem: (k: string) => store.get(k) ?? null,
          setItem: (k: string, v: string) => void store.set(k, v),
          removeItem: (k: string) => void store.delete(k),
        },
        configurable: true,
        writable: true,
      });
    });

    afterEach(() => {
      if (original) Object.defineProperty(globalThis, "localStorage", original);
      else Reflect.deleteProperty(globalThis, "localStorage");
    });

    it("defaults to detail with nothing stored", () => {
      expect(loadScreenContentMode()).toBe("detail");
    });

    it("round-trips a choice", () => {
      storeScreenContentMode("motion");
      expect(localStorage.getItem(SCREEN_CONTENT_STORAGE_KEY)).toBe("motion");
      expect(loadScreenContentMode()).toBe("motion");
      storeScreenContentMode("detail");
      expect(loadScreenContentMode()).toBe("detail");
    });

    it("falls back to detail for anything unrecognised", () => {
      localStorage.setItem(SCREEN_CONTENT_STORAGE_KEY, "sideways");
      expect(loadScreenContentMode()).toBe("detail");
    });
  });
});

describe("the capture ceiling", () => {
  it("pins a resolution rather than only asking for one", () => {
    // `ideal` alone is a hint a screen capture may ignore, and a 4K source
    // handed back at native size spreads the bitrate over four times the
    // pixels it was chosen for.
    const profile = getScreenSharePublishProfile(60, 12_000_000);
    expect(profile.maxWidth).toBe(SCREEN_MAX_WIDTH);
    expect(profile.maxHeight).toBe(SCREEN_MAX_HEIGHT);
    expect(SCREEN_MAX_WIDTH).toBe(1920);
    expect(SCREEN_MAX_HEIGHT).toBe(1080);
  });
});

describe("codec preference", () => {
  const codec = (mimeType: string) => ({ mimeType });

  it("puts VP9 ahead of what the browser would have picked", () => {
    const ordered = orderVideoCodecs([
      codec("video/VP8"),
      codec("video/H264"),
      codec("video/VP9"),
    ]);
    expect(ordered.map((c) => c.mimeType)).toEqual([
      "video/VP9",
      "video/VP8",
      "video/H264",
    ]);
  });

  it("keeps every codec it was given", () => {
    // Filtering rather than reordering would mean a peer that only has the
    // dropped codec cannot receive the share at all.
    const input = [codec("video/AV1"), codec("video/VP8"), codec("video/rtx")];
    const ordered = orderVideoCodecs(input);
    expect(ordered).toHaveLength(input.length);
    expect(new Set(ordered.map((c) => c.mimeType))).toEqual(
      new Set(input.map((c) => c.mimeType)),
    );
  });

  it("leaves codecs it has no opinion about in the order they came", () => {
    const ordered = orderVideoCodecs([
      codec("video/AV1"),
      codec("video/rtx"),
      codec("video/VP9"),
    ]);
    expect(ordered.map((c) => c.mimeType)).toEqual([
      "video/VP9",
      "video/AV1",
      "video/rtx",
    ]);
  });

  it("matches a mime type whatever its case", () => {
    const ordered = orderVideoCodecs([codec("video/vp8"), codec("video/vp9")]);
    expect(ordered[0].mimeType).toBe("video/vp9");
  });

  it("copes with a list that holds none of its preferences", () => {
    const ordered = orderVideoCodecs([codec("video/AV1"), codec("video/rtx")]);
    expect(ordered.map((c) => c.mimeType)).toEqual(["video/AV1", "video/rtx"]);
  });
});
