import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem } from "@/components/ui/dropdown-menu";

interface VoiceToolbarProps {
  inVoiceChannel: boolean;
  isMuted: boolean;
  voiceInputMode: "open" | "ptt";
  isScreenSharing: boolean;
  screenFps: 30 | 60;
  debugOpen: boolean;
  onJoinVoice: () => void;
  onLeaveVoice: () => void;
  onToggleMute: () => void;
  onToggleInputMode: () => void;
  hideScreenShare?: boolean;
  onStartScreenShare: () => void;
  onStopScreenShare: () => void;
  onSetScreenFps: (fps: 30 | 60) => void;
  onToggleDebug: () => void;
}

export function VoiceToolbar({
  inVoiceChannel,
  isMuted,
  voiceInputMode,
  isScreenSharing,
  screenFps,
  debugOpen,
  onJoinVoice,
  onLeaveVoice,
  onToggleMute,
  onToggleInputMode,
  hideScreenShare,
  onStartScreenShare,
  onStopScreenShare,
  onSetScreenFps,
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
        <Button
          size="sm"
          variant={isMuted ? "destructive" : "outline"}
          onClick={onToggleMute}
          className="text-xs w-full"
        >
          {isMuted ? "🔇 Unmute" : "🎤 Mute"}
        </Button>
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
