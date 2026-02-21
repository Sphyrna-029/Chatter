import { describe, it, expect } from "vitest";
import {
  getScreenSharePublishProfile,
  mungeScreenVideoSdp,
} from "@/lib/webrtc";

describe("Screen share quality configuration (maxed)", () => {
  describe("30fps profile", () => {
    const profile = getScreenSharePublishProfile(30);

    it("uses motion contentHint", () => {
      expect(profile.contentHint).toBe("motion");
    });

    it("starts at max bitrate", () => {
      expect(profile.startBitrateKbps).toBe(profile.maxBitrateKbps);
    });

    it("has 50 Mbps max bitrate", () => {
      expect(profile.maxBitrateBps).toBe(50_000_000);
    });

    it("has 20 Mbps min bitrate floor", () => {
      expect(profile.minBitrateKbps).toBe(20_000);
    });

    it("targets 30fps", () => {
      expect(profile.targetFps).toBe(30);
    });
  });

  describe("60fps profile", () => {
    const profile = getScreenSharePublishProfile(60);

    it("has 80 Mbps max bitrate", () => {
      expect(profile.maxBitrateBps).toBe(80_000_000);
    });

    it("starts at max bitrate", () => {
      expect(profile.startBitrateKbps).toBe(profile.maxBitrateKbps);
    });

    it("has 30 Mbps min bitrate floor", () => {
      expect(profile.minBitrateKbps).toBe(30_000);
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

    it("injects maxed bitrate hints into SDP", () => {
      const profile = getScreenSharePublishProfile(30);
      const munged = mungeScreenVideoSdp(fakeSdp, {
        startBitrateKbps: profile.startBitrateKbps,
        minBitrateKbps: profile.minBitrateKbps,
        maxBitrateKbps: profile.maxBitrateKbps,
      });
      expect(munged).toContain("x-google-start-bitrate=50000");
      expect(munged).toContain("x-google-min-bitrate=20000");
      expect(munged).toContain("x-google-max-bitrate=50000");
    });
  });
});
