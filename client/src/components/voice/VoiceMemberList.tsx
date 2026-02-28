import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/components/ui/tooltip";
import { cn, displayUserId } from "@/lib/utils";
import type { PeerStats } from "@/lib/webrtc";

interface VoiceMemberListProps {
  inVoiceChannel: boolean;
  voiceMembers: string[];
  userId: string | null;
  isMuted: boolean;
  voiceMemberStates: Record<string, { muted: boolean; screen_sharing: boolean }>;
  activeScreenSharers: string[];
  selectedScreenSharer: string | null;
  screenViewerOpen: boolean;
  connStats: Record<string, PeerStats>;
  speakingUsers: Set<string>;
  volumes: Record<string, number>;
  onSetUserVolume: (userId: string, vol: number) => void;
  onWatchUser: (sharerId: string) => void;
}


export function VoiceMemberList({
  inVoiceChannel,
  voiceMembers,
  userId,
  isMuted,
  voiceMemberStates,
  activeScreenSharers,
  selectedScreenSharer,
  screenViewerOpen,
  connStats,
  speakingUsers,
  volumes,
  onSetUserVolume,
  onWatchUser,
}: VoiceMemberListProps) {
  if (voiceMembers.length === 0) return null;

  return (
    <div className="flex-1 overflow-y-auto px-2 py-2">
      <div className="flex flex-col gap-1">
        {voiceMembers.map((memberId) => {
          const name = displayUserId(memberId);
          const isSelf = memberId === userId;
          const memberState = voiceMemberStates[memberId];
          const isMutedMember = memberState?.muted || (isSelf && isMuted);
          const isSharing = memberState?.screen_sharing || activeScreenSharers.includes(memberId);
          const vol = volumes[memberId] ?? 1;
          const isSpeaking = speakingUsers.has(memberId) && !isMutedMember;
          const isWatching = selectedScreenSharer === memberId && screenViewerOpen;

          return (
            <div key={memberId} className={cn(
              "flex flex-col rounded-md px-2 py-1.5 transition-shadow duration-150",
              isSpeaking && "shadow-[0_0_8px_2px_rgba(34,197,94,0.5)]"
            )}>
              {/* Name row: mute icon, latency dot, name */}
              <div className="flex items-center gap-1 text-sm min-w-0">
                <span className={cn("text-xs flex-shrink-0", isMutedMember ? "text-destructive" : isSpeaking ? "text-green-500" : "")}>
                  {isMutedMember ? "🔇" : "🎤"}
                </span>
                {(() => {
                  const statsKey = isSelf ? "voice-pub" : `voice-sub:${memberId}`;
                  const rtt = connStats[statsKey]?.rtt;
                  const rttMs = rtt != null ? Math.round(rtt * 1000) : null;
                  const dotColor = rttMs == null
                    ? "text-muted-foreground"
                    : rttMs < 100
                      ? "text-green-500"
                      : rttMs <= 300
                        ? "text-orange-500"
                        : "text-red-500";
                  return (
                    <TooltipProvider delayDuration={200}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className={cn("text-[8px] leading-none flex-shrink-0", dotColor)}>●</span>
                        </TooltipTrigger>
                        <TooltipContent side="right" className="text-xs">
                          {rttMs != null ? `${rttMs}ms` : "No data"}
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  );
                })()}
                <span className={cn("truncate", isSpeaking && "text-green-400 font-semibold")}>
                  {name}{isSelf && " (You)"}
                </span>
              </div>
              {/* Sharing badge */}
              {isSharing && (
                <span className="text-[10px] text-purple-400 font-semibold px-1 py-0.5 rounded-md bg-purple-500/10 mt-0.5 w-fit">
                  📺 Sharing
                </span>
              )}
              {/* Volume slider and watch — only for users in voice */}
              {inVoiceChannel && !isSelf && (
                <div className="flex flex-col gap-0.5 mt-1 w-full">
                  <div className="flex items-center gap-1 w-full">
                    <Slider
                      value={[vol * 100]}
                      onValueChange={([v]) => onSetUserVolume(memberId, v / 100)}
                      max={100}
                      step={1}
                      className="flex-1"
                    />
                    <span className="text-[10px] text-muted-foreground w-6 text-right">
                      {Math.round(vol * 100)}
                    </span>
                  </div>
                  {isSharing && (
                    <Button
                      size="sm"
                      variant={isWatching ? "secondary" : "outline"}
                      onClick={(e) => {
                        e.stopPropagation();
                        onWatchUser(memberId);
                      }}
                      className={cn(
                        "h-5 px-1.5 text-[10px] font-semibold w-full",
                        isWatching
                          ? "bg-purple-600 text-white hover:bg-purple-700 border-purple-600"
                          : "border-purple-500/50 text-purple-400 hover:bg-purple-500/20 hover:text-purple-300"
                      )}
                      title={isWatching ? `Stop watching ${name}'s screen` : `Watch ${name}'s screen`}
                    >
                      📺 {isWatching ? "Watching" : "Watch"}
                    </Button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
