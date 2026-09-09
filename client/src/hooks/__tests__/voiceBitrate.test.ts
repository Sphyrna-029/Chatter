import { describe, it, expect } from "vitest";
import {
  clampVoiceBitrate,
  mungeVoiceAudioSdp,
  VOICE_BITRATE_MIN_BPS,
  VOICE_BITRATE_MAX_BPS,
  VOICE_BITRATE_DEFAULT_BPS,
  VOICE_PTIME_MS,
  VOICE_MAXPTIME_MS,
} from "@/lib/webrtc";

const SDP_WITH_FMTP = [
  "v=0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "a=rtpmap:111 opus/48000/2",
  "a=fmtp:111 minptime=10;useinbandfec=1",
  "",
].join("\r\n");

describe("clampVoiceBitrate", () => {
  it("falls back to the default when unset", () => {
    expect(clampVoiceBitrate(undefined)).toBe(VOICE_BITRATE_DEFAULT_BPS);
    expect(clampVoiceBitrate(null)).toBe(VOICE_BITRATE_DEFAULT_BPS);
    expect(clampVoiceBitrate(NaN)).toBe(VOICE_BITRATE_DEFAULT_BPS);
  });

  it("clamps to the supported range", () => {
    expect(clampVoiceBitrate(1_000)).toBe(VOICE_BITRATE_MIN_BPS);
    expect(clampVoiceBitrate(1_000_000)).toBe(VOICE_BITRATE_MAX_BPS);
    expect(clampVoiceBitrate(96_000)).toBe(96_000);
  });
});

describe("mungeVoiceAudioSdp", () => {
  it("sets maxaveragebitrate while keeping existing fmtp params", () => {
    const out = mungeVoiceAudioSdp(SDP_WITH_FMTP, 128_000);
    expect(out).toContain("a=fmtp:111 minptime=10;useinbandfec=1;maxaveragebitrate=128000");
  });

  it("replaces an existing maxaveragebitrate rather than duplicating it", () => {
    const sdp = SDP_WITH_FMTP.replace(
      "a=fmtp:111 minptime=10;useinbandfec=1",
      "a=fmtp:111 minptime=10;maxaveragebitrate=24000;useinbandfec=1",
    );
    const out = mungeVoiceAudioSdp(sdp, 64_000);
    expect(out).toContain("a=fmtp:111 minptime=10;useinbandfec=1;maxaveragebitrate=64000");
    expect(out).not.toContain("maxaveragebitrate=24000");
  });

  it("inserts an fmtp line when the answer has none", () => {
    const sdp = SDP_WITH_FMTP.replace("a=fmtp:111 minptime=10;useinbandfec=1\r\n", "");
    const out = mungeVoiceAudioSdp(sdp, 8_000);
    expect(out).toContain("a=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;useinbandfec=1;maxaveragebitrate=8000");
  });

  it("clamps out-of-range bitrates", () => {
    expect(mungeVoiceAudioSdp(SDP_WITH_FMTP, 900_000)).toContain(`maxaveragebitrate=${VOICE_BITRATE_MAX_BPS}`);
    expect(mungeVoiceAudioSdp(SDP_WITH_FMTP, 100)).toContain(`maxaveragebitrate=${VOICE_BITRATE_MIN_BPS}`);
  });

  it("enables DTX so silent publishers stop sending", () => {
    expect(mungeVoiceAudioSdp(SDP_WITH_FMTP, 64_000)).toContain("usedtx=1");
  });

  it("does not duplicate usedtx when the answer already carries it", () => {
    const sdp = SDP_WITH_FMTP.replace(
      "a=fmtp:111 minptime=10;useinbandfec=1",
      "a=fmtp:111 minptime=10;usedtx=0;useinbandfec=1",
    );
    const out = mungeVoiceAudioSdp(sdp, 64_000);
    expect(out).toContain("usedtx=1");
    expect(out).not.toContain("usedtx=0");
    expect(out.match(/usedtx=/g)).toHaveLength(1);
  });

  it("leaves SDP without an opus track untouched", () => {
    const sdp = "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 VP8/90000\r\n";
    expect(mungeVoiceAudioSdp(sdp, 64_000)).toBe(sdp);
  });
});

describe("voice packetisation", () => {
  it("asks the publisher for the longer frame", () => {
    // The cheapest capacity there is: half the packets for 20ms of latency.
    const out = mungeVoiceAudioSdp(SDP_WITH_FMTP, VOICE_BITRATE_DEFAULT_BPS);
    expect(out).toContain(`a=ptime:${VOICE_PTIME_MS}`);
    expect(out).toContain(`a=maxptime:${VOICE_MAXPTIME_MS}`);
  });

  it("replaces the answer's own ptime rather than adding a second one", () => {
    const sdp = SDP_WITH_FMTP.replace(
      "a=fmtp:111 minptime=10;useinbandfec=1",
      "a=fmtp:111 minptime=10;useinbandfec=1\r\na=ptime:20\r\na=maxptime:60",
    );
    const out = mungeVoiceAudioSdp(sdp, VOICE_BITRATE_DEFAULT_BPS);
    expect(out).not.toContain("a=ptime:20");
    expect(out).not.toContain("a=maxptime:60");
    expect(out.match(/a=ptime:/g)).toHaveLength(1);
    expect(out.match(/a=maxptime:/g)).toHaveLength(1);
  });

  it("puts them inside the audio section, after the fmtp line", () => {
    // A media-level attribute landing above the m= line applies to the session
    // and is ignored; one landing in another section applies to the wrong media.
    const out = mungeVoiceAudioSdp(SDP_WITH_FMTP, VOICE_BITRATE_DEFAULT_BPS);
    const lines = out.split("\r\n");
    expect(lines.indexOf(`a=ptime:${VOICE_PTIME_MS}`)).toBeGreaterThan(
      lines.findIndex((l) => l.startsWith("m=audio")),
    );
    expect(lines.indexOf(`a=ptime:${VOICE_PTIME_MS}`)).toBe(
      lines.findIndex((l) => l.startsWith("a=fmtp:111")) + 1,
    );
  });

  it("leaves an SDP with no opus alone", () => {
    const noOpus = "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 VP8/90000\r\n";
    expect(mungeVoiceAudioSdp(noOpus, VOICE_BITRATE_DEFAULT_BPS)).toBe(noOpus);
  });
});
