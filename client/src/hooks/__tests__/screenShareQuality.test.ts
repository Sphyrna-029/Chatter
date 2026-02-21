import { describe, it, expect } from "vitest";
import {
  getScreenSharePublishProfile,
  mungeScreenVideoSdp,
} from "@/lib/webrtc";

describe("Screen share quality configuration", () => {
  describe("30fps profile", () => {
    const profile = getScreenSharePublishProfile(30);

    it("uses maintain-framerate-compatible contentHint (motion)", () => {
      expect(profile.contentHint).toBe("motion");
    });

    it("starts at max bitrate for instant 1080p", () => {
      expect(profile.startBitrateKbps).toBe(profile.maxBitrateKbps);
    });

    it("has minBitrateKbps >= 4000 to prevent encoder drops", () => {
      expect(profile.minBitrateKbps).toBeGreaterThanOrEqual(4000);
    });

    it("targets 30fps", () => {
      expect(profile.targetFps).toBe(30);
    });

    it("has maxBitrateBps of 12 Mbps", () => {
      expect(profile.maxBitrateBps).toBe(12_000_000);
    });
  });

  describe("60fps profile", () => {
    const profile = getScreenSharePublishProfile(60);

    it("uses motion contentHint", () => {
      expect(profile.contentHint).toBe("motion");
    });

    it("starts at max bitrate for instant 1080p", () => {
      expect(profile.startBitrateKbps).toBe(profile.maxBitrateKbps);
    });

    it("has minBitrateKbps >= 6000 to prevent encoder drops", () => {
      expect(profile.minBitrateKbps).toBeGreaterThanOrEqual(6000);
    });

    it("targets 60fps", () => {
      expect(profile.targetFps).toBe(60);
    });
  });

  describe("SDP munging", () => {
    const fakeSdp = [
      "v=0",
      "m=video 9 UDP/TLS/RTP/SAVPF 96",
      "a=rtpmap:96 VP8/90000",
      "",
    ].join("\r\n");

    it("sets x-google-start-bitrate equal to max for 30fps profile", () => {
      const profile = getScreenSharePublishProfile(30);
      const munged = mungeScreenVideoSdp(fakeSdp, {
        startBitrateKbps: profile.startBitrateKbps,
        minBitrateKbps: profile.minBitrateKbps,
        maxBitrateKbps: profile.maxBitrateKbps,
      });
      const startMatch = munged.match(/x-google-start-bitrate=(\d+)/);
      const maxMatch = munged.match(/x-google-max-bitrate=(\d+)/);
      expect(startMatch).not.toBeNull();
      expect(maxMatch).not.toBeNull();
      expect(Number(startMatch![1])).toBe(Number(maxMatch![1]));
    });

    it("sets x-google-min-bitrate >= 4000 for 30fps profile", () => {
      const profile = getScreenSharePublishProfile(30);
      const munged = mungeScreenVideoSdp(fakeSdp, {
        startBitrateKbps: profile.startBitrateKbps,
        minBitrateKbps: profile.minBitrateKbps,
        maxBitrateKbps: profile.maxBitrateKbps,
      });
      const match = munged.match(/x-google-min-bitrate=(\d+)/);
      expect(match).not.toBeNull();
      expect(Number(match![1])).toBeGreaterThanOrEqual(4000);
    });
  });
});
