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

interface VoiceControlsProps {
  joinVoiceRef?: React.MutableRefObject<(() => void) | null>;
}

export function VoiceControls({ joinVoiceRef }: VoiceControlsProps) {
  const { state } = useAppContext();
  const [debugOpen, setDebugOpen] = useState(false);
  const [volumes, setVolumes] = useState<Record<string, number>>({});

  // Cross-hook cleanup coordination
  const cleanupScreenRef = useRef(async () => {});

  const voice = useWebRTCVoice({ cleanupScreenRef });
  const screen = useWebRTCScreen();

  // Expose joinVoice to parent via ref
  useEffect(() => {
    if (joinVoiceRef) joinVoiceRef.current = voice.joinVoice;
    return () => { if (joinVoiceRef) joinVoiceRef.current = null; };
  }, [joinVoiceRef, voice.joinVoice]);

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

  // Speaking detection
  const speakingUsers = useSpeakingDetection(
    state.inVoiceChannel,
    state.userId,
    voice.localStreamRef,
    voice.voiceAudioElementsRef,
  );

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
        voiceInputMode={state.voiceInputMode}
        isScreenSharing={state.isScreenSharing}
        screenFps={screen.screenFps}
        debugOpen={debugOpen}
        onJoinVoice={voice.joinVoice}
        onLeaveVoice={voice.leaveVoice}
        onToggleMute={voice.toggleMute}
        onToggleInputMode={voice.toggleInputMode}
        onStartScreenShare={screen.startScreenShare}
        onStopScreenShare={screen.stopScreenShare}
        onSetScreenFps={screen.setScreenFps}
        onToggleDebug={() => setDebugOpen((o) => !o)}
      />
    </div>
  );
}
