import { useState, useMemo } from "react";
import { ChevronLeft, ChevronRight, Crown, Shield } from "lucide-react";
import { useAppContext } from "@/lib/store";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { UserProfileDialog } from "./UserProfileDialog";

interface MembersPanelProps {
  collapsed: boolean;
  onToggle: () => void;
}

export function MembersPanel({ collapsed, onToggle }: MembersPanelProps) {
  const { state } = useAppContext();
  const [profileOpen, setProfileOpen] = useState(false);
  const [selectedMember, setSelectedMember] = useState<{
    userId: string;
    displayName: string;
  } | null>(null);

  const roomInfo = state.currentRoomId
    ? state.roomInfoMap[state.currentRoomId]
    : null;

  const grouped = useMemo(() => {
    const owners: typeof state.roomMembers = [];
    const moderators: typeof state.roomMembers = [];
    const members: typeof state.roomMembers = [];
    for (const m of state.roomMembers) {
      if (m.role === "owner") owners.push(m);
      else if (m.role === "moderator") moderators.push(m);
      else members.push(m);
    }
    return { owners, moderators, members };
  }, [state.roomMembers]);

  if (!state.currentRoomId) return null;

  if (collapsed) {
    return (
      <div className="w-8 border-l flex flex-col items-center pt-3 shrink-0">
        <button
          onClick={onToggle}
          title="Show members"
          className="h-7 w-7 rounded-md flex items-center justify-center text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
      </div>
    );
  }

  const renderMember = (member: (typeof state.roomMembers)[0]) => {
    const presence = state.userPresence[member.userId];
    const status = presence?.status || "offline";
    const customStatus = presence?.customStatus;
    const initial = member.displayName[0]?.toUpperCase() || "?";

    const nameColor =
      member.role === "owner" && roomInfo?.owner_name_color
        ? roomInfo.owner_name_color
        : member.role === "moderator" && roomInfo?.mod_name_color
          ? roomInfo.mod_name_color
          : undefined;

    return (
      <div
        key={member.userId}
        onClick={() => {
          setSelectedMember(member);
          setProfileOpen(true);
        }}
        className={cn(
          "flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors cursor-pointer hover:bg-accent/50",
          status === "offline" && "opacity-50"
        )}
      >
        <div className="relative flex-shrink-0">
          <Avatar className="h-7 w-7">
            {presence?.avatarUrl && <AvatarImage src={presence.avatarUrl} />}
            <AvatarFallback className="text-xs bg-secondary">
              {initial}
            </AvatarFallback>
          </Avatar>
          <span
            className={cn(
              "absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-background",
              (status === "active" || status === "online") && "bg-green-500",
              (status === "idle" || status === "away") && "bg-yellow-500",
              status === "dnd" && "bg-red-500",
              status === "offline" && "bg-muted-foreground"
            )}
          />
        </div>
        <div className="min-w-0 flex-1">
          <span className="flex items-center gap-1">
            <span
              className={cn(
                "truncate text-sm block",
                status === "offline" && "text-muted-foreground"
              )}
              style={nameColor ? { color: nameColor } : undefined}
            >
              {member.displayName}
            </span>
            {member.role === "owner" && (
              <Crown className="h-3 w-3 text-yellow-500 shrink-0" />
            )}
            {member.role === "moderator" && (
              <Shield className="h-3 w-3 text-blue-400 shrink-0" />
            )}
          </span>
          {customStatus && (
            <span className="truncate text-[0.625rem] leading-tight text-muted-foreground block">
              {customStatus}
            </span>
          )}
        </div>
      </div>
    );
  };

  const renderSection = (
    label: string,
    items: typeof state.roomMembers,
    count?: number
  ) => {
    if (items.length === 0) return null;
    return (
      <div>
        <p className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground px-2 pt-3 pb-1">
          {label} — {count ?? items.length}
        </p>
        {items.map(renderMember)}
      </div>
    );
  };

  return (
    <div className="w-56 border-l flex flex-col shrink-0">
      <div className="flex items-center gap-2 border-b px-3 py-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Members
        </h3>
        <span className="inline-flex items-center rounded-full bg-secondary px-2 py-0.5 text-xs font-medium">
          {state.roomMembers.length}
        </span>
        <button
          onClick={onToggle}
          title="Hide members"
          className="ml-auto h-6 w-6 rounded flex items-center justify-center text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>

      <ScrollArea className="flex-1 p-2">
        <div className="space-y-0.5">
          {renderSection("Owner", grouped.owners)}
          {renderSection("Moderators", grouped.moderators)}
          {renderSection("Members", grouped.members)}
        </div>
      </ScrollArea>

      {selectedMember && (
        <UserProfileDialog
          open={profileOpen}
          onOpenChange={setProfileOpen}
          userId={selectedMember.userId}
          displayName={selectedMember.displayName}
        />
      )}
    </div>
  );
}
