import { describe, it, expect } from "vitest";
import { getScreenSharePublishProfile } from "@/lib/webrtc";

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
