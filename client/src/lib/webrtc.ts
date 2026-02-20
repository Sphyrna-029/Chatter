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

// Munge the SDP for the screen share publisher to force high-fidelity stereo Opus.
// This overrides WebRTC's default voice-optimised codec parameters.
export function mungeScreenAudioSdp(sdp: string): string {
  const opusMatch = sdp.match(/a=rtpmap:(\d+) opus\/48000/i);
  if (!opusMatch) return sdp;
  const pt = opusMatch[1];
  const highQualityFmtp = `a=fmtp:${pt} useinbandfec=1; stereo=1; sprop-stereo=1; maxaveragebitrate=64000`;
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
