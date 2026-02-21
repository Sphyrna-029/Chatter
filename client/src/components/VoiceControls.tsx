import { useRef, useEffect, useState, useCallback } from "react";
import { useAppContext } from "@/lib/store";
import { useWebRTCVoice } from "@/hooks/useWebRTCVoice";
import { useWebRTCScreen } from "@/hooks/useWebRTCScreen";
import { useConnectionStats } from "@/hooks/useConnectionStats";
import { useSpeakingDetection } from "@/hooks/useSpeakingDetection";
import { VoiceToolbar } from "./voice/VoiceToolbar";
import { VoiceDebugPanel } from "./voice/VoiceDebugPanel";
import { VoiceMemberList } from "./voice/VoiceMemberList";

export function VoiceControls() {
  const { state } = useAppContext();
  const [debugOpen, setDebugOpen] = useState(false);
  const [volumes, setVolumes] = useState<Record<string, number>>({});

  // Cross-hook cleanup coordination
  const cleanupScreenRef = useRef(async () => {});

  const voice = useWebRTCVoice({ cleanupScreenRef });
  const screen = useWebRTCScreen();

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

  return (
    <div className="flex flex-col">
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

      {debugOpen && state.inVoiceChannel && (
        <VoiceDebugPanel connStats={connStats} />
      )}

      <VoiceMemberList
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
    </div>
  );
}
