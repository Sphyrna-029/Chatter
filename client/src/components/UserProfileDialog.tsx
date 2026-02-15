import { useMemo } from "react";
import { useAppContext } from "@/lib/store";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface UserProfileDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
  displayName: string;
}

export function UserProfileDialog({
  open,
  onOpenChange,
  userId,
  displayName,
}: UserProfileDialogProps) {
  const { state, openDM } = useAppContext();
  const isSelf = userId === state.userId;
  const presence = state.userPresence[userId];
  const status = presence?.status || "offline";
  const initial = displayName[0]?.toUpperCase() || "?";

  const joinDate = useMemo(() => {
    const joinMsg = state.messages.find(
      (m) =>
        m.content.msgtype === "m.system" &&
        m.sender === userId &&
        m.content.body.includes("has joined")
    );
    if (!joinMsg) return null;
    return new Date(joinMsg.origin_server_ts);
  }, [state.messages, userId]);

  const handleMessage = async () => {
    await openDM(userId);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[340px]">
        <DialogHeader>
          <DialogTitle className="sr-only">User Profile</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col items-center gap-4 py-2">
          <Avatar className="h-20 w-20">
            <AvatarFallback className="text-2xl bg-secondary">
              {initial}
            </AvatarFallback>
          </Avatar>

          <div className="text-center space-y-1">
            <h2 className="text-lg font-semibold">{displayName}</h2>
            <p className="text-sm text-muted-foreground">{userId}</p>
          </div>

          <div className="flex items-center gap-2">
            <span
              className={cn(
                "h-2.5 w-2.5 rounded-full",
                status === "active" && "bg-green-500",
                status === "idle" && "bg-yellow-500",
                status === "offline" && "bg-muted-foreground"
              )}
            />
            <span className="text-sm capitalize">{status}</span>
          </div>

          {joinDate && (
            <p className="text-xs text-muted-foreground">
              Joined{" "}
              {joinDate.toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </p>
          )}

          {!isSelf && (
            <Button className="w-full mt-2" onClick={handleMessage}>
              Message
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
