export const WEBRTC_CONFIG = {
  iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }],
};

export const VOICE_SUBSCRIBE_RETRY_MS = 1000;
export const SCREEN_SUBSCRIBE_RETRY_MS = 1000;

export interface PeerStats {
  rtt: number | null;
  bitrate: number | null;
  audioBitrate: number | null;
  videoBitrate: number | null;
  packetsLost: number | null;
  audioPacketsLost: number | null;
  framesPerSecond: number | null;
  resolution: string | null;
  connectionState: string;
  // Audio quality indicators
  audioJitter: number | null;       // seconds (display as ms)
  audioLevel: number | null;        // 0-1 instantaneous level from media-source
  concealmentRatio: number | null;  // fraction of samples concealed due to packet loss
  audioCodec: string | null;        // e.g. "opus/48000/2"
}

export function canSignal(wsRef: React.MutableRefObject<WebSocket | null>) {
  return wsRef.current && wsRef.current.readyState === WebSocket.OPEN;
}

export interface ScreenShareVideoSdpTuning {
  startBitrateKbps: number;
  minBitrateKbps: number;
  maxBitrateKbps: number;
}

export interface ScreenShareAudioSdpTuning {
  maxAverageBitrate: number;
}

export interface ScreenSharePublishProfile {
  targetFps: 30 | 60;
  contentHint: "detail" | "motion";
  maxBitrateBps: number;
  startBitrateKbps: number;
  minBitrateKbps: number;
  maxBitrateKbps: number;
  audioMaxAverageBitrate: number;
}

const SCREEN_PROFILE_30FPS: ScreenSharePublishProfile = {
  targetFps: 30,
  contentHint: "motion",
  maxBitrateBps: 12_000_000,
  startBitrateKbps: 10_000,
  minBitrateKbps: 4_000,
  maxBitrateKbps: 12_000,
  audioMaxAverageBitrate: 48_000,
};

const SCREEN_PROFILE_60FPS: ScreenSharePublishProfile = {
  targetFps: 60,
  contentHint: "motion",
  maxBitrateBps: 20_000_000,
  startBitrateKbps: 16_000,
  minBitrateKbps: 6_000,
  maxBitrateKbps: 20_000,
  audioMaxAverageBitrate: 48_000,
};

export function getScreenSharePublishProfile(
  fps: 30 | 60,
): ScreenSharePublishProfile {
  return fps === 60 ? SCREEN_PROFILE_60FPS : SCREEN_PROFILE_30FPS;
}

function upsertFmtpParam(rawFmtp: string, key: string, value: number): string {
  const keyPattern = new RegExp(`(^|;\\s*)${key}=\\d+`, "i");
  if (keyPattern.test(rawFmtp)) {
    return rawFmtp.replace(keyPattern, `$1${key}=${value}`);
  }
  return `${rawFmtp}; ${key}=${value}`;
}

// Munge the SDP for the screen share publisher video codecs to speed up
// bitrate ramp-up and avoid prolonged low-resolution startup.
export function mungeScreenVideoSdp(
  sdp: string,
  tuning: ScreenShareVideoSdpTuning,
): string {
  const videoPayloads = new Set<string>();
  const rtpmapRegex = /a=rtpmap:(\d+)\s+([A-Za-z0-9]+)/gi;

  let match: RegExpExecArray | null;
  while ((match = rtpmapRegex.exec(sdp))) {
    const codec = match[2].toUpperCase();
    if (codec === "VP8" || codec === "VP9" || codec === "H264" || codec === "AV1") {
      videoPayloads.add(match[1]);
    }
  }

  for (const payloadType of videoPayloads) {
    const fmtpRegex = new RegExp(`a=fmtp:${payloadType} ([^\\r\\n]+)`, "i");
    const applyHints = (existingFmtp: string) => {
      let next = upsertFmtpParam(
        existingFmtp,
        "x-google-start-bitrate",
        tuning.startBitrateKbps,
      );
      next = upsertFmtpParam(next, "x-google-min-bitrate", tuning.minBitrateKbps);
      next = upsertFmtpParam(next, "x-google-max-bitrate", tuning.maxBitrateKbps);
      return next;
    };

    if (fmtpRegex.test(sdp)) {
      sdp = sdp.replace(fmtpRegex, (_, existing) => {
        return `a=fmtp:${payloadType} ${applyHints(existing)}`;
      });
      continue;
    }

    const rtpmapLineRegex = new RegExp(
      `(a=rtpmap:${payloadType}\\s+[^\\r\\n]+\\r?\\n)`,
      "i",
    );
    sdp = sdp.replace(
      rtpmapLineRegex,
      `$1a=fmtp:${payloadType} x-google-start-bitrate=${tuning.startBitrateKbps}; x-google-min-bitrate=${tuning.minBitrateKbps}; x-google-max-bitrate=${tuning.maxBitrateKbps}\r\n`,
    );
  }

  return sdp;
}

// Munge the SDP for the screen share publisher audio to keep system audio clear
// without consuming more congestion budget than needed.
export function mungeScreenAudioSdp(
  sdp: string,
  tuning: ScreenShareAudioSdpTuning = { maxAverageBitrate: 48_000 },
): string {
  const opusMatch = sdp.match(/a=rtpmap:(\d+) opus\/48000/i);
  if (!opusMatch) return sdp;
  const pt = opusMatch[1];
  const highQualityFmtp =
    `a=fmtp:${pt} useinbandfec=1; stereo=1; sprop-stereo=1; usedtx=1; maxaveragebitrate=${tuning.maxAverageBitrate}`;
  const existingFmtp = new RegExp(`a=fmtp:${pt} [^\r\n]+`);
  if (existingFmtp.test(sdp)) {
    return sdp.replace(existingFmtp, highQualityFmtp);
  }
  // No existing fmtp line — insert one after the rtpmap line
  return sdp.replace(
    new RegExp(`(a=rtpmap:${pt} opus\\/48000[^\r\n]*\r?\n)`),
    `$1${highQualityFmtp}\r\n`,
  );
}
