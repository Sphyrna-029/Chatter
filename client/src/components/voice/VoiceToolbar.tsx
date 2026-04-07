import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem } from "@/components/ui/dropdown-menu";

interface VoiceToolbarProps {
  inVoiceChannel: boolean;
  isMuted: boolean;
  isDeafened: boolean;
  voiceInputMode: "open" | "ptt";
  isScreenSharing: boolean;
  screenFps: 30 | 60;
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
  onSetScreenFps: (fps: 30 | 60) => void;
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
  screenFps,
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
  onSetScreenFps,
  onStartWebcam,
  onStopWebcam,
  onToggleDebug,
}: VoiceToolbarProps) {
  if (!inVoiceChannel) return null;

  return (
    <div className="flex flex-col gap-1.5 border-t p-2">
      <Button
        size="sm"
        variant="destructive"
        onClick={onLeaveVoice}
        className="text-xs w-full"
      >
        🔇 Leave Voice
      </Button>

      {voiceInputMode === "open" && (
        <div className="flex gap-1.5">
          <Button
            size="sm"
            variant={isMuted || isDeafened ? "destructive" : "outline"}
            onClick={onToggleMute}
            className="text-xs flex-1"
            disabled={isDeafened}
            title={isDeafened ? "Undeafen to unmute" : isMuted ? "Unmute" : "Mute"}
          >
            {isMuted || isDeafened ? "🔇 Unmute" : "🎤 Mute"}
          </Button>
          <Button
            size="sm"
            variant={isDeafened ? "destructive" : "outline"}
            onClick={onToggleDeafen}
            className="text-xs flex-1"
            title={isDeafened ? "Undeafen" : "Deafen"}
          >
            {isDeafened ? "🔕 Undeafen" : "🔕 Deafen"}
          </Button>
        </div>
      )}

      <Button
        size="sm"
        variant={voiceInputMode === "ptt" ? "secondary" : "outline"}
        onClick={onToggleInputMode}
        className="text-xs w-full"
      >
        {voiceInputMode === "ptt" ? "🔑 PTT (`)" : "🎙 Open Mic"}
      </Button>

      {!hideScreenShare && (
        <div className="flex items-center">
          <Button
            size="sm"
            variant={isScreenSharing ? "destructive" : "outline"}
            onClick={isScreenSharing ? onStopScreenShare : onStartScreenShare}
            className="text-xs flex-1 rounded-r-none"
          >
            {isScreenSharing ? "🖥️ Stop" : `🖥️ Share (${screenFps}fps)`}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant={isScreenSharing ? "destructive" : "outline"}
                className="text-xs rounded-l-none border-l-0 px-1.5"
              >
                ▾
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuRadioGroup value={String(screenFps)} onValueChange={(v) => onSetScreenFps(Number(v) as 30 | 60)}>
                <DropdownMenuRadioItem value="30">30 FPS</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="60">60 FPS</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}

      <Button
        size="sm"
        variant={isWebcamActive ? "destructive" : "outline"}
        onClick={isWebcamActive ? onStopWebcam : onStartWebcam}
        className="text-xs w-full"
        title={isWebcamActive ? "Stop camera" : "Share camera"}
      >
        {isWebcamActive ? "📷 Stop Camera" : "📷 Share Camera"}
      </Button>

      {voiceInputMode === "ptt" && !isMuted && (
        <span className="text-xs text-green-500 font-semibold animate-pulse text-center">
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
