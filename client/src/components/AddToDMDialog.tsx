import { useState, useMemo } from "react";
import { useAppContext } from "@/lib/store";
import { displayUserId } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { AuthAvatarImage } from "@/components/AuthImage";

const MAX_DM_MEMBERS = 20;

interface AddToDMDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roomId: string;
}

export function AddToDMDialog({ open, onOpenChange, roomId }: AddToDMDialogProps) {
  const { state, addToGroupDM } = useAppContext();
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentMembers = useMemo(() => {
    return state.roomMembers.map((m) => m.userId);
  }, [state.roomMembers]);

  const memberCount = currentMembers.length;
  const atLimit = memberCount >= MAX_DM_MEMBERS;

  const candidates = useMemo(() => {
    const q = search.trim().toLowerCase();
    return Object.entries(state.userPresence)
      .filter(([uid]) => {
        if (uid === state.userId) return false;
        if (currentMembers.includes(uid)) return false;
        if (!q) return true;
        const display = (state.userPresence[uid]?.displayName || displayUserId(uid)).toLowerCase();
        return display.includes(q) || uid.toLowerCase().includes(q);
      })
      .slice(0, 20);
  }, [search, state.userPresence, state.userId, currentMembers]);

  async function handleAdd(userId: string) {
    if (adding || atLimit) return;
    setAdding(true);
    setError(null);
    try {
      await addToGroupDM(roomId, userId);
      onOpenChange(false);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to add user");
    } finally {
      setAdding(false);
    }
  }

  function handleOpenChange(val: boolean) {
    if (!val) {
      setSearch("");
      setError(null);
    }
    onOpenChange(val);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Add people to DM</DialogTitle>
          <DialogDescription>
            {memberCount}/{MAX_DM_MEMBERS} members
          </DialogDescription>
        </DialogHeader>

        {atLimit ? (
          <p className="text-sm text-muted-foreground text-center py-4">
            This group DM has reached the 20-member limit.
          </p>
        ) : (
          <>
            <Input
              placeholder="Search users..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex flex-col gap-1 max-h-64 overflow-y-auto">
              {candidates.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">
                  {search ? "No users found" : "No other users available"}
                </p>
              ) : (
                candidates.map(([uid, presence]) => {
                  const displayName = presence?.displayName || displayUserId(uid);
                  const initial = displayName.substring(0, 1).toUpperCase();
                  return (
                    <div
                      key={uid}
                      className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-accent cursor-pointer"
                      onClick={() => handleAdd(uid)}
                    >
                      <Avatar className="h-7 w-7 shrink-0">
                        <AuthAvatarImage src={presence?.avatarUrl} />
                        <AvatarFallback className="text-xs">{initial}</AvatarFallback>
                      </Avatar>
                      <span className="text-sm truncate">{displayName}</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="ml-auto text-xs h-6 px-2"
                        disabled={adding}
                        onClick={(e) => { e.stopPropagation(); handleAdd(uid); }}
                      >
                        Add
                      </Button>
                    </div>
                  );
                })
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
