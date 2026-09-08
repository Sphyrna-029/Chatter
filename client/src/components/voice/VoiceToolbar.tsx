import { Button } from "@/components/ui/button";
import { ScreenFpsMenu } from "./ScreenFpsMenu";
import { useScreenShareFps } from "@/hooks/useScreenShareFps";

interface VoiceToolbarProps {
  inVoiceChannel: boolean;
  isMuted: boolean;
  isDeafened: boolean;
  voiceInputMode: "open" | "ptt";
  isScreenSharing: boolean;
  isWebcamActive: boolean;
  debugOpen: boolean;
  onJoinVoice: () => void;
  onLeaveVoice: () => void;
  onToggleMute: () => void;
  onToggleDeafen: () => void;
  onToggleInputMode: () => void;
  hideScreenShare?: boolean;
  onStartScreenShare: () => void;
  onStopScreenShare: () => void;
  onStartWebcam: () => void;
  onStopWebcam: () => void;
  onToggleDebug: () => void;
}

export function VoiceToolbar({
  inVoiceChannel,
  isMuted,
  isDeafened,
  voiceInputMode,
  isScreenSharing,
  isWebcamActive,
  debugOpen,
  onJoinVoice,
  onLeaveVoice,
  onToggleMute,
  onToggleDeafen,
  onToggleInputMode,
  hideScreenShare,
  onStartScreenShare,
  onStopScreenShare,
  onStartWebcam,
  onStopWebcam,
  onToggleDebug,
}: VoiceToolbarProps) {
  const { screenFps } = useScreenShareFps();
  if (!inVoiceChannel) return null;

  return (
    <div className="flex flex-col gap-1.5 border-t p-2">
      <div className="flex items-center gap-1.5">
        <Button
          size="sm"
          variant={isWebcamActive ? "destructive" : "outline"}
          onClick={isWebcamActive ? onStopWebcam : onStartWebcam}
          className="text-xs px-2"
          title={isWebcamActive ? "Stop camera" : "Share camera"}
        >
          📷
        </Button>

        {!hideScreenShare && (
          <div className="flex items-center flex-1">
            <Button
              size="sm"
              variant={isScreenSharing ? "destructive" : "outline"}
              onClick={isScreenSharing ? onStopScreenShare : onStartScreenShare}
              className="text-xs flex-1 rounded-r-none"
            >
              {isScreenSharing ? "🖥️ Stop" : `🖥️ Share (${screenFps}fps)`}
            </Button>
            <ScreenFpsMenu>
              <Button
                size="sm"
                variant={isScreenSharing ? "destructive" : "outline"}
                className="text-xs rounded-l-none border-l-0 px-1.5"
                title="Screen share quality"
              >
                ▾
              </Button>
            </ScreenFpsMenu>
          </div>
        )}
      </div>

      {/* Three across: labels give way to icons so mute, deafen and hang up
          fit one row of the narrow sidebar. */}
      <div className="flex items-center gap-1.5">
        {voiceInputMode === "open" && (
          <>
            <Button
              size="sm"
              variant={isMuted || isDeafened ? "destructive" : "outline"}
              onClick={onToggleMute}
              className="text-xs px-2"
              disabled={isDeafened}
              title={isDeafened ? "Undeafen to unmute" : isMuted ? "Unmute" : "Mute"}
            >
              {isMuted || isDeafened ? "🔇" : "🎤"}
            </Button>
            <Button
              size="sm"
              variant={isDeafened ? "destructive" : "outline"}
              onClick={onToggleDeafen}
              className="text-xs px-2"
              title={isDeafened ? "Undeafen" : "Deafen"}
            >
              {isDeafened ? "🔕" : "🎧"}
            </Button>
          </>
        )}
        <Button
          size="sm"
          variant="destructive"
          onClick={onLeaveVoice}
          className="text-xs flex-1"
          title="Leave voice channel"
        >
          📞 Leave
        </Button>
      </div>

      <Button
        size="sm"
        variant={voiceInputMode === "ptt" ? "secondary" : "outline"}
        onClick={onToggleInputMode}
        className="text-xs w-full"
      >
        {voiceInputMode === "ptt" ? "🔑 PTT (`)" : "🎙 Open Mic"}
      </Button>

      {voiceInputMode === "ptt" && !isMuted && (
        <span className="text-xs text-success font-semibold animate-pulse text-center">
          🔊 Transmitting
        </span>
      )}

      <Button
        size="sm"
        variant={debugOpen ? "secondary" : "ghost"}
        onClick={onToggleDebug}
        className="text-xs w-full"
      >
        Debug
      </Button>
    </div>
  );
}
