import { describe, it, expect } from "vitest";
import { getWebcamPublishProfile } from "@/lib/webrtc";

describe("Webcam quality configuration", () => {
  describe("30fps profile", () => {
    const profile = getWebcamPublishProfile(30);

    it("uses motion contentHint", () => {
      expect(profile.contentHint).toBe("motion");
    });

    it("targets 30fps", () => {
      expect(profile.targetFps).toBe(30);
    });

    it("has 2.5 Mbps max bitrate", () => {
      expect(profile.maxBitrateBps).toBe(2_500_000);
    });
  });

  describe("60fps profile", () => {
    const profile = getWebcamPublishProfile(60);

    it("targets 60fps", () => {
      expect(profile.targetFps).toBe(60);
    });

    it("has 4 Mbps max bitrate", () => {
      expect(profile.maxBitrateBps).toBe(4_000_000);
    });
  });

  it("gives 60fps more bitrate than 30fps", () => {
    expect(getWebcamPublishProfile(60).maxBitrateBps).toBeGreaterThan(
      getWebcamPublishProfile(30).maxBitrateBps,
    );
  });

  it("stays below the screen share budget — cameras are 720p, not 1080p desktops", () => {
    expect(getWebcamPublishProfile(60).maxBitrateBps).toBeLessThan(8_000_000);
  });
});
