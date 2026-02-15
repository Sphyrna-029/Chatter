import { useState } from "react";
import { useAppContext } from "@/lib/store";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { UserProfileDialog } from "./UserProfileDialog";

export function MembersPanel() {
  const { state } = useAppContext();
  const [profileOpen, setProfileOpen] = useState(false);
  const [selectedMember, setSelectedMember] = useState<{
    userId: string;
    displayName: string;
  } | null>(null);

  if (!state.currentRoomId) return null;

  return (
    <div className="w-56 border-l flex flex-col">
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Members
        </h3>
        <span className="inline-flex items-center rounded-full bg-secondary px-2 py-0.5 text-xs font-medium">
          {state.roomMembers.length}
        </span>
      </div>

      <ScrollArea className="flex-1 p-2">
        <div className="space-y-0.5">
          {state.roomMembers.map((member) => {
            const presence = state.userPresence[member.userId];
            const status = presence?.status || "offline";
            const customStatus = presence?.customStatus;
            const initial = member.displayName[0]?.toUpperCase() || "?";

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
                    <AvatarFallback className="text-xs bg-secondary">
                      {initial}
                    </AvatarFallback>
                  </Avatar>
                  <span
                    className={cn(
                      "absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-background",
                      status === "active" && "bg-green-500",
                      status === "idle" && "bg-yellow-500",
                      status === "offline" && "bg-muted-foreground"
                    )}
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <span
                    className={cn(
                      "truncate text-sm block",
                      status === "offline" && "text-muted-foreground"
                    )}
                  >
                    {member.displayName}
                  </span>
                  {customStatus && (
                    <span className="truncate text-[0.625rem] leading-tight text-muted-foreground block">
                      {customStatus}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
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
