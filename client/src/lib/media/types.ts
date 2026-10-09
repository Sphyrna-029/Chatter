// What voice needs from a media stack, so the same signalling code in
// useWebRTCVoice can run on the browser's WebRTC or on the desktop app's
// native engine.
//
// The split is deliberate. Everything Chatter-specific — the protocol, retries,
// SDP munging, moderation — stays in the hook and is shared by both. A backend
// only provides what a browser provides: a peer connection, a microphone, and
// the playout graph (per-speaker gain and position).
//
// This file is part of the desktop contract (see lib/desktop/bridge.ts): the
// desktop app implements VoiceMediaBackend and type-checks against it, so
// change it additively.

import type { NoiseSuppressionMode } from "@/hooks/useVoiceSettings";

export interface VoiceIceCandidate {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  usernameFragment?: string | null;
}

/** What `ontrack` hands over. Opaque here; the backend that made it reads it. */
export interface VoiceTrackEvent {
  readonly transceiver: unknown;
  readonly track: unknown;
  readonly streams: readonly unknown[];
}

export interface VoiceSender {
  readonly track: { readonly kind: string } | null;
  getParameters(): RTCRtpSendParameters;
  setParameters(parameters: RTCRtpSendParameters): Promise<void>;
}

/** The W3C stats shape: `report.type`, `kind`, `bytesSent`, … */
export interface VoiceStatsReport {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  forEach(callback: (report: any) => void): void;
}

/** The part of RTCPeerConnection voice uses. A browser's RTCPeerConnection is
 *  one; the desktop engine provides a stand-in with the same behaviour. */
export interface VoicePeer {
  readonly connectionState: RTCPeerConnectionState;
  onicecandidate: ((event: { readonly candidate: VoiceIceCandidate | null }) => void) | null;
  onconnectionstatechange: (() => void) | null;
  ontrack: ((event: VoiceTrackEvent) => void) | null;
  addTransceiver(kind: "audio", init: { direction: "recvonly" }): unknown;
  getTransceivers(): readonly unknown[];
  getSenders(): readonly VoiceSender[];
  createOffer(): Promise<RTCSessionDescriptionInit>;
  setLocalDescription(description: RTCSessionDescriptionInit): Promise<void>;
  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
  addIceCandidate(candidate: RTCIceCandidateInit): Promise<void>;
  restartIce(): void;
  getStats(): Promise<VoiceStatsReport>;
  close(): void;
}

export interface MicOptions {
  deviceId: string;
  echoCancellation: boolean;
  noiseSuppression: NoiseSuppressionMode;
  autoGainControl: boolean;
  /** Linear gain applied before sending; 1 is unchanged. */
  gain: number;
}

export interface LocalMic {
  /** Publish this microphone on a peer (the voice publisher). */
  attachTo(peer: VoicePeer): void;
  /** Mute without tearing anything down: the track stays, silence is sent. */
  setEnabled(on: boolean): void;
  /** For the local speaking indicator, polled every frame. */
  isSpeaking(): boolean;
  /** Apply changed settings to a live mic, e.g. a different device or gain. */
  update(options: MicOptions): Promise<void>;
  stop(): void;
}

export interface WorldPosition {
  x: number;
  y: number;
  z: number;
}

export interface AudioDevice {
  id: string;
  label: string;
}

export interface MicTest {
  setMonitoring(on: boolean): Promise<void>;
  setGain(gain: number): void;
  stop(): void;
}

/** Where screen shares come from. The browser's getDisplayMedia, or the
 *  desktop app's, which adds the shared app's own audio. */
export interface DisplayCaptureBackend {
  getDisplayMedia(options: DisplayMediaStreamOptions): Promise<MediaStream>;
}

export interface VoiceMediaBackend {
  readonly kind: "browser" | "native";
  /** Noise suppression modes this backend can run, for the settings menu. */
  readonly noiseSuppressionModes: readonly NoiseSuppressionMode[];

  createPeer(config: RTCConfiguration): VoicePeer;
  acquireMic(options: MicOptions): Promise<LocalMic>;

  // Playout: one graph for the whole call, keyed by slot (see useWebRTCVoice).
  attachSlot(slot: number, event: VoiceTrackEvent): void;
  setSlotGain(slot: number, gain: number): void;
  setSlotPosition(slot: number, at: WorldPosition): void;
  setListenerPosition(at: WorldPosition): void;
  setOutput(options: { deviceId: string; volume: number }): void;
  closeGraph(): void;

  // Settings dialog
  listDevices(): Promise<{ inputs: AudioDevice[]; outputs: AudioDevice[] }>;
  onDevicesChanged(listener: () => void): () => void;
  startMicTest(
    options: MicOptions & { outputDeviceId: string },
    onLevel: (level: number) => void,
  ): Promise<MicTest>;
}
