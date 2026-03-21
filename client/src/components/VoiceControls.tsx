import { useRef, useEffect, useState, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAppContext } from "@/lib/store";
import { useWebRTCVoice } from "@/hooks/useWebRTCVoice";
import { useWebRTCScreen } from "@/hooks/useWebRTCScreen";
import { useConnectionStats } from "@/hooks/useConnectionStats";
import { useSpeakingDetection } from "@/hooks/useSpeakingDetection";
import { VoiceToolbar } from "./voice/VoiceToolbar";
import { VoiceDebugPanel } from "./voice/VoiceDebugPanel";
import { VoiceMemberList } from "./voice/VoiceMemberList";

export type ConnectionQuality = 0 | 1 | 2 | 3 | 4;
export type VoiceConnectionStatus = "new" | "connecting" | "connected" | "disconnected" | "failed" | "closed";
export interface ConnQualityData { quality: ConnectionQuality; pingMs: number | null; status: VoiceConnectionStatus; }

interface VoiceControlsProps {
  joinVoiceRef?: React.MutableRefObject<((channelId?: string) => void) | null>;
  leaveVoiceRef?: React.MutableRefObject<(() => void) | null>;
  toggleMuteRef?: React.MutableRefObject<(() => void) | null>;
  toggleDeafenRef?: React.MutableRefObject<(() => void) | null>;
  startScreenShareRef?: React.MutableRefObject<(() => void) | null>;
  stopScreenShareRef?: React.MutableRefObject<(() => void) | null>;
  connQualityRef?: React.MutableRefObject<ConnQualityData>;
  setUserVolumeRef?: React.MutableRefObject<((userId: string, vol: number) => void) | null>;
  speakingUsersRef?: React.MutableRefObject<Set<string>>;
}

function computeQuality(connStats: Record<string, import("@/lib/webrtc").PeerStats>): ConnectionQuality {
  const pub = connStats["voice-pub"];
  if (!pub || pub.connectionState === "new" || pub.connectionState === "connecting") return 0;
  if (pub.connectionState === "failed" || pub.connectionState === "disconnected" || pub.connectionState === "closed") return 0;

  const rttMs = (pub.rtt ?? 0) * 1000;
  const jitterMs = (pub.audioJitter ?? 0) * 1000;
  const loss = pub.audioPacketsLost ?? 0;

  // Score: 4 = excellent, 3 = good, 2 = fair, 1 = poor
  if (rttMs < 80 && jitterMs < 20 && loss < 5) return 4;
  if (rttMs < 150 && jitterMs < 40 && loss < 20) return 3;
  if (rttMs < 300 && jitterMs < 80 && loss < 50) return 2;
  return 1;
}

export function VoiceControls({ joinVoiceRef, leaveVoiceRef, toggleMuteRef, toggleDeafenRef, startScreenShareRef, stopScreenShareRef, connQualityRef, setUserVolumeRef, speakingUsersRef }: VoiceControlsProps) {
  const { state } = useAppContext();
  const [debugOpen, setDebugOpen] = useState(false);
  const [volumes, setVolumes] = useState<Record<string, number>>({});

  // Cross-hook cleanup coordination
  const cleanupScreenRef = useRef(async () => {});

  const voice = useWebRTCVoice({ cleanupScreenRef });
  const screen = useWebRTCScreen();

  // Expose voice actions to parent via refs
  useEffect(() => {
    if (joinVoiceRef) joinVoiceRef.current = voice.joinVoice;
    return () => { if (joinVoiceRef) joinVoiceRef.current = null; };
  }, [joinVoiceRef, voice.joinVoice]);

  useEffect(() => {
    if (leaveVoiceRef) leaveVoiceRef.current = voice.leaveVoice;
    return () => { if (leaveVoiceRef) leaveVoiceRef.current = null; };
  }, [leaveVoiceRef, voice.leaveVoice]);

  useEffect(() => {
    if (toggleMuteRef) toggleMuteRef.current = voice.toggleMute;
    return () => { if (toggleMuteRef) toggleMuteRef.current = null; };
  }, [toggleMuteRef, voice.toggleMute]);

  useEffect(() => {
    if (toggleDeafenRef) toggleDeafenRef.current = voice.toggleDeafen;
    return () => { if (toggleDeafenRef) toggleDeafenRef.current = null; };
  }, [toggleDeafenRef, voice.toggleDeafen]);

  useEffect(() => {
    if (startScreenShareRef) startScreenShareRef.current = screen.startScreenShare;
    return () => { if (startScreenShareRef) startScreenShareRef.current = null; };
  }, [startScreenShareRef, screen.startScreenShare]);

  useEffect(() => {
    if (stopScreenShareRef) stopScreenShareRef.current = screen.stopScreenShare;
    return () => { if (stopScreenShareRef) stopScreenShareRef.current = null; };
  }, [stopScreenShareRef, screen.stopScreenShare]);

  useEffect(() => {
    if (setUserVolumeRef) setUserVolumeRef.current = voice.setUserVolume;
    return () => { if (setUserVolumeRef) setUserVolumeRef.current = null; };
  }, [setUserVolumeRef, voice.setUserVolume]);

  // Wire up the cleanup ref after both hooks are initialized
  cleanupScreenRef.current = screen.fullCleanup;

  // Connection stats polling
  const connStats = useConnectionStats(state.inVoiceChannel, {
    voicePublisherPcRef: voice.voicePublisherPcRef,
    voiceSubscriberPcsRef: voice.voiceSubscriberPcsRef,
    screenPubPcRef: screen.screenPubPcRef,
    screenSubPcsRef: screen.screenSubPcsRef,
  });

  // Feed stats to screen hook for frozen detection
  useEffect(() => {
    screen.updateConnStats(connStats);
  }, [connStats, screen.updateConnStats]);

  // Expose connection quality to parent — update on every render so the ref
  // is always fresh (the ChannelList polls this ref via setInterval).
  if (connQualityRef) {
    const pub = connStats["voice-pub"];
    const pingMs = pub?.rtt != null ? Math.round(pub.rtt * 1000) : null;
    connQualityRef.current = {
      quality: state.inVoiceChannel ? computeQuality(connStats) : 0,
      pingMs: state.inVoiceChannel ? pingMs : null,
      status: (state.inVoiceChannel
        ? pub?.connectionState ?? voice.voicePublisherPcRef.current?.connectionState ?? "new"
        : "closed") as VoiceConnectionStatus,
    };
  }

  // Speaking detection
  const speakingUsers = useSpeakingDetection(
    state.inVoiceChannel,
    state.userId,
    voice.localStreamRef,
    voice.voiceAudioElementsRef,
  );
  // Expose to parent (e.g. ChannelList speaking indicator)
  if (speakingUsersRef) speakingUsersRef.current = speakingUsers;

  // Volume control bridge
  const setUserVolume = useCallback((userId: string, vol: number) => {
    voice.setUserVolume(userId, vol);
    setVolumes((v) => ({ ...v, [userId]: vol }));
  }, [voice.setUserVolume]);

  // Watch user bridge (needs joinVoice from voice hook)
  const watchUser = useCallback(async (sharerId: string) => {
    await screen.watchUser(sharerId, voice.joinVoice);
  }, [screen.watchUser, voice.joinVoice]);

  if (!state.currentRoomId) return null;
  if (state.voiceMembers.length === 0) return null;

  return (
    <div className="w-52 border-r flex flex-col h-full shrink-0">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Voice Channel
        </span>
        <span className="inline-flex items-center rounded-full bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          {state.voiceMembers.length}
        </span>
      </div>

      {/* Members list */}
      <VoiceMemberList
        inVoiceChannel={state.inVoiceChannel}
        voiceMembers={state.voiceMembers}
        userId={state.userId}
        isMuted={state.isMuted}
        voiceMemberStates={state.voiceMemberStates}
        activeScreenSharers={state.activeScreenSharers}
        selectedScreenSharer={state.selectedScreenSharer}
        screenViewerOpen={state.screenViewerOpen}
        connStats={connStats}
        speakingUsers={speakingUsers}
        volumes={volumes}
        userPresence={state.userPresence}
        onSetUserVolume={setUserVolume}
        onWatchUser={watchUser}
      />

      {/* Debug modal */}
      <Dialog open={debugOpen && state.inVoiceChannel} onOpenChange={setDebugOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>WebRTC Debug</DialogTitle>
          </DialogHeader>
          <VoiceDebugPanel connStats={connStats} />
        </DialogContent>
      </Dialog>

      {/* Controls at bottom */}
      <VoiceToolbar
        inVoiceChannel={state.inVoiceChannel}
        isMuted={state.isMuted}
        isDeafened={state.isDeafened}
        voiceInputMode={state.voiceInputMode}
        isScreenSharing={state.isScreenSharing}
        screenFps={screen.screenFps}
        debugOpen={debugOpen}
        hideScreenShare={
          (state.voiceRoomId
            ? state.roomInfoMap[state.voiceRoomId]?.room_type
            : state.currentRoomId
              ? state.roomInfoMap[state.currentRoomId]?.room_type
              : undefined) === "watchparty"
        }
        onJoinVoice={voice.joinVoice}
        onLeaveVoice={voice.leaveVoice}
        onToggleMute={voice.toggleMute}
        onToggleDeafen={voice.toggleDeafen}
        onToggleInputMode={voice.toggleInputMode}
        onStartScreenShare={screen.startScreenShare}
        onStopScreenShare={screen.stopScreenShare}
        onSetScreenFps={screen.setScreenFps}
        onToggleDebug={() => setDebugOpen((o) => !o)}
      />
    </div>
  );
}
