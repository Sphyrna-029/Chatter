import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { AuthAvatarImage } from "@/components/AuthImage";
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
  activeWebcamStreamers: string[];
  selectedScreenSharer: string | null;
  screenViewerOpen: boolean;
  connStats: Record<string, PeerStats>;
  speakingUsers: Set<string>;
  volumes: Record<string, number>;
  userPresence: Record<
    string,
    { displayName?: string; avatarUrl?: string; [key: string]: unknown }
  >;
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
  activeWebcamStreamers,
  selectedScreenSharer,
  screenViewerOpen,
  connStats,
  speakingUsers,
  volumes,
  userPresence,
  onSetUserVolume,
  onWatchUser,
}: VoiceMemberListProps) {
  if (voiceMembers.length === 0) return null;

  return (
    <div className="flex-1 overflow-y-auto px-2 py-2">
      <div className="flex flex-col gap-1">
        {voiceMembers.map((memberId) => {
          const name = userPresence[memberId]?.displayName || displayUserId(memberId);
          const isSelf = memberId === userId;
          const memberState = voiceMemberStates[memberId];
          const isMutedMember = memberState?.muted || (isSelf && isMuted);
          const isSharing = memberState?.screen_sharing || activeScreenSharers.includes(memberId);
          const isWebcamStreaming = activeWebcamStreamers.includes(memberId);
          const vol = volumes[memberId] ?? 1;
          const isSpeaking = speakingUsers.has(memberId) && !isMutedMember;
          const isWatching = selectedScreenSharer === memberId && screenViewerOpen;

          return (
            <div key={memberId} className={cn(
              "flex flex-col rounded-md px-2 py-1.5 transition-shadow duration-150 min-w-0 overflow-hidden",
              isSpeaking && "shadow-[0_0_8px_2px_var(--success)]"
            )}>
              {/* Name row: mute icon, latency dot, name */}
              <div className="flex items-center gap-1 text-sm min-w-0">
                <span className={cn("text-xs flex-shrink-0", isMutedMember ? "text-destructive" : isSpeaking ? "text-success" : "")}>
                  {isMutedMember ? "🔇" : "🎤"}
                </span>
                {(() => {
                  const statsKey = isSelf ? "voice-pub" : `voice-sub:${memberId}`;
                  const rtt = connStats[statsKey]?.rtt;
                  const rttMs = rtt != null ? Math.round(rtt * 1000) : null;
                  const dotColor = rttMs == null
                    ? "text-muted-foreground"
                    : rttMs < 100
                      ? "text-success"
                      : rttMs <= 300
                        ? "text-orange-500"
                        : "text-destructive";
                  return (
                    <TooltipProvider delayDuration={200}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className={cn("text-3xs leading-none flex-shrink-0", dotColor)}>●</span>
                        </TooltipTrigger>
                        <TooltipContent side="right" className="text-xs">
                          {rttMs != null ? `${rttMs}ms` : "No data"}
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  );
                })()}
                <Avatar className="h-6 w-6 shrink-0">
                  <AuthAvatarImage src={userPresence[memberId]?.avatarUrl} />
                  <AvatarFallback className="text-2xs bg-secondary">
                    {name[0]?.toUpperCase() || "?"}
                  </AvatarFallback>
                </Avatar>
                <span className={cn("truncate", isSpeaking && "text-success font-semibold")}>
                  {name}{isSelf && " (You)"}
                </span>
                {isWebcamStreaming && (
                  <span className="text-3xs shrink-0 text-blue-400" title="Sharing camera">📷</span>
                )}
              </div>
              {/* Sharing badge — clickable to open/toggle stream */}
              {isSharing && (
                <button
                  type="button"
                  onClick={() => onWatchUser(memberId)}
                  className={cn(
                    "text-3xs font-semibold px-1 py-0.5 rounded-md mt-0.5 w-fit transition-colors cursor-pointer",
                    isWatching
                      ? "text-purple-200 bg-purple-600/40 hover:bg-purple-600/60"
                      : "text-purple-400 bg-purple-500/10 hover:bg-purple-500/20"
                  )}
                >
                  📺 {isWatching ? "Watching" : "Watch Stream"}
                </button>
              )}
              {/* Volume slider and watch — only for users in voice */}
              {inVoiceChannel && !isSelf && (
                <div className="flex flex-col gap-0.5 mt-1 w-full">
                  <div className="flex items-center gap-1 w-full">
                    <Slider
                      value={[vol * 100]}
                      onValueChange={([v]) => onSetUserVolume(memberId, v / 100)}
                      max={150}
                      step={1}
                      className="flex-1"
                    />
                    <span className="text-3xs text-muted-foreground w-8 text-right">
                      {Math.round(vol * 100)}%
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
                        "h-5 px-1.5 text-3xs font-semibold w-full",
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
