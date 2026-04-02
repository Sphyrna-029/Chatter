// Fallback config used until the server responds
const DEFAULT_WEBRTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }],
};

// Populated from /api/ice-servers on startup
let _cachedConfig: RTCConfiguration | null = null;

export async function fetchIceServers(): Promise<void> {
  try {
    const token = localStorage.getItem("access_token");
    if (!token) return;
    const res = await fetch("/api/ice-servers", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      _cachedConfig = await res.json();
    }
  } catch {
    // Use default config
  }
}

export function getWebRTCConfig(): RTCConfiguration {
  return _cachedConfig ?? DEFAULT_WEBRTC_CONFIG;
}

export const VOICE_SUBSCRIBE_RETRY_MS = 1500;
export const SCREEN_SUBSCRIBE_RETRY_MS = 1500;
export const VOICE_SUBSCRIBE_MAX_RETRIES = 8;
export const VOICE_SUBSCRIBE_MAX_BACKOFF_MS = 30_000;
// Publisher retries should be fast — it's the critical path for voice
export const VOICE_PUBLISH_INITIAL_RETRY_MS = 300;
export const VOICE_PUBLISH_MAX_BACKOFF_MS = 5_000;
// Timeouts for detecting stuck peer connections
export const VOICE_SUB_STUCK_NEW_MS = 2500;
export const VOICE_SUB_STUCK_CONNECTING_MS = 10_000;

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

export interface ScreenShareAudioSdpTuning {
  maxAverageBitrate: number;
}

export interface ScreenSharePublishProfile {
  targetFps: 30 | 60;
  contentHint: "detail" | "motion";
  maxBitrateBps: number;
  audioMaxAverageBitrate: number;
}

const SCREEN_PROFILE_30FPS: ScreenSharePublishProfile = {
  targetFps: 30,
  contentHint: "motion",
  maxBitrateBps: 8_000_000,
  audioMaxAverageBitrate: 128_000,
};

const SCREEN_PROFILE_60FPS: ScreenSharePublishProfile = {
  targetFps: 60,
  contentHint: "motion",
  maxBitrateBps: 12_000_000,
  audioMaxAverageBitrate: 128_000,
};

export function getScreenSharePublishProfile(
  fps: 30 | 60,
): ScreenSharePublishProfile {
  return fps === 60 ? SCREEN_PROFILE_60FPS : SCREEN_PROFILE_30FPS;
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
