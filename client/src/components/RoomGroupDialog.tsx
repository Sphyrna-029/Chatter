import { useState, useEffect } from "react";
import { useAppContext } from "@/lib/store";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";

interface RoomGroupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "create" | "rename" | "manage";
  groupId?: string;
  groupName?: string;
}

export function RoomGroupDialog({ open, onOpenChange, mode, groupId, groupName }: RoomGroupDialogProps) {
  const { state, createRoomGroup, renameRoomGroup, setGroupRooms, loadRoomGroups } = useAppContext();
  const [name, setName] = useState(groupName || "");
  const [selectedRoomIds, setSelectedRoomIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open) {
      if (mode === "rename") {
        setName(groupName || "");
      } else if (mode === "create") {
        setName("");
      } else if (mode === "manage" && groupId) {
        const group = state.roomGroups.find((g) => g.group_id === groupId);
        setSelectedRoomIds(group?.room_ids || []);
      }
    }
  }, [open, mode, groupId, groupName, state.roomGroups]);

  const regularRoomIds = state.joinedRoomIds.filter(
    (id) => !state.roomInfoMap[id]?.is_direct
  );

  const handleSubmit = async () => {
    setLoading(true);
    try {
      if (mode === "create") {
        await createRoomGroup(name.trim());
      } else if (mode === "rename" && groupId) {
        await renameRoomGroup(groupId, name.trim());
      } else if (mode === "manage" && groupId) {
        await setGroupRooms(groupId, selectedRoomIds);
      }
      onOpenChange(false);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  };

  const toggleRoom = (roomId: string) => {
    setSelectedRoomIds((prev) =>
      prev.includes(roomId)
        ? prev.filter((id) => id !== roomId)
        : [...prev, roomId]
    );
  };

  const title =
    mode === "create" ? "Create Group" :
    mode === "rename" ? "Rename Group" :
    "Manage Group Rooms";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        {(mode === "create" || mode === "rename") && (
          <div className="space-y-3">
            <Input
              placeholder="Group name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && name.trim()) handleSubmit();
              }}
              autoFocus
            />
            <Button
              className="w-full"
              onClick={handleSubmit}
              disabled={!name.trim() || loading}
            >
              {mode === "create" ? "Create" : "Rename"}
            </Button>
          </div>
        )}

        {mode === "manage" && (
          <div className="space-y-3">
            <ScrollArea className="h-[300px]">
              <div className="space-y-1 pr-3">
                {regularRoomIds.map((roomId) => {
                  const info = state.roomInfoMap[roomId];
                  const roomName = info?.name || "Unnamed";
                  const checked = selectedRoomIds.includes(roomId);
                  return (
                    <label
                      key={roomId}
                      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleRoom(roomId)}
                        className="h-4 w-4 rounded border-border accent-primary shrink-0"
                      />
                      {info?.icon_url && (
                        <img src={info.icon_url} alt="" className="h-5 w-5 rounded object-cover" />
                      )}
                      <span className="truncate">{roomName}</span>
                    </label>
                  );
                })}
                {regularRoomIds.length === 0 && (
                  <p className="text-xs text-muted-foreground px-2 py-3">No rooms joined</p>
                )}
              </div>
            </ScrollArea>
            <Button className="w-full" onClick={handleSubmit} disabled={loading}>
              Save
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
