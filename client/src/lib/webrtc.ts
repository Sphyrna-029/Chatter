import { getAccessToken } from "./api";

// Fallback config used until the server responds
const DEFAULT_WEBRTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }],
};

// Populated from /api/ice-servers on startup
let _cachedConfig: RTCConfiguration | null = null;

export async function fetchIceServers(): Promise<void> {
  try {
    const token = getAccessToken();
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

// ─── Voice channel bitrate ──────────────────────────────────────────────────
// Per-channel Opus bitrate, configured by room owners/moderators and applied by
// every publisher in that channel. Keep in sync with VOICE_BITRATE_* in
// src/backend/constants.rs.
export const VOICE_BITRATE_MIN_BPS = 8_000;
export const VOICE_BITRATE_MAX_BPS = 256_000;
export const VOICE_BITRATE_DEFAULT_BPS = 64_000;

export function clampVoiceBitrate(bps: number | null | undefined): number {
  if (bps == null || !Number.isFinite(bps)) return VOICE_BITRATE_DEFAULT_BPS;
  return Math.min(Math.max(Math.round(bps), VOICE_BITRATE_MIN_BPS), VOICE_BITRATE_MAX_BPS);
}

// Rewrite the opus fmtp line to target the channel bitrate. For Opus it is the
// *receiver's* SDP that tells our encoder what to send, so this is applied to
// the SFU's answer before setRemoteDescription — not to our own offer.
export function mungeVoiceAudioSdp(sdp: string, bitrateBps: number): string {
  const opusMatch = sdp.match(/a=rtpmap:(\d+) opus\/48000/i);
  if (!opusMatch) return sdp;
  const pt = opusMatch[1];
  const bitrate = clampVoiceBitrate(bitrateBps);
  const existingFmtp = new RegExp(`a=fmtp:${pt} [^\r\n]+`);
  const existing = sdp.match(existingFmtp);
  const params = (existing?.[0].slice(`a=fmtp:${pt} `.length) ?? "minptime=10;useinbandfec=1")
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && !/^maxaveragebitrate=/i.test(p));
  params.push(`maxaveragebitrate=${bitrate}`);
  const line = `a=fmtp:${pt} ${params.join(";")}`;
  if (existing) return sdp.replace(existingFmtp, line);
  // No existing fmtp line — insert one after the rtpmap line
  return sdp.replace(
    new RegExp(`(a=rtpmap:${pt} opus\\/48000[^\r\n]*\r?\n)`),
    `$1${line}\r\n`,
  );
}

// Cap the publisher's outgoing audio bitrate. Unlike SDP munging this takes
// effect live, so a mid-call bitrate change needs no renegotiation.
export async function applyVoiceSenderBitrate(
  pc: RTCPeerConnection,
  bitrateBps: number,
): Promise<void> {
  const sender = pc.getSenders().find((s) => s.track?.kind === "audio");
  if (!sender) return;
  const params = sender.getParameters();
  if (!params.encodings || params.encodings.length === 0) {
    params.encodings = [{}];
  }
  params.encodings[0].maxBitrate = clampVoiceBitrate(bitrateBps);
  try {
    await sender.setParameters(params);
  } catch {
    // Some browsers reject setParameters before negotiation completes — the
    // SDP-level maxaveragebitrate still applies.
  }
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
