import { useState, useEffect } from "react";
import { useAppContext } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface CreateRoomDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateRoomDialog({ open, onOpenChange }: CreateRoomDialogProps) {
  const { createRoom } = useAppContext();
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [loading, setLoading] = useState(false);

  const handleCreate = async () => {
    if (!name) return;
    setLoading(true);
    try {
      await createRoom(name, topic);
      setName("");
      setTopic("");
      onOpenChange(false);
    } catch {
      alert("Failed to create room");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create New Room</DialogTitle>
          <DialogDescription>
            Create a new chat room for your team.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="room-name">Room Name</Label>
            <Input
              id="room-name"
              placeholder="My Awesome Room"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="room-topic">Topic (Optional)</Label>
            <Input
              id="room-topic"
              placeholder="Discuss awesome things"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={!name || loading}>
            {loading ? "Creating..." : "Create Room"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface JoinRoomDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function JoinRoomDialog({ open, onOpenChange }: JoinRoomDialogProps) {
  const { state, joinRoom, getAllRooms } = useAppContext();
  const [rooms, setRooms] = useState<
    { room_id: string; name: string; member_count: number }[]
  >([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open) {
      getAllRooms().then((allRooms) => {
        const filtered = allRooms.filter(
          (r) => !state.joinedRoomIds.includes(r.room_id)
        );
        setRooms(filtered);
        setSelected(filtered[0]?.room_id || null);
      });
    }
  }, [open, state.joinedRoomIds, getAllRooms]);

  const handleJoin = async () => {
    if (!selected) return;
    setLoading(true);
    try {
      await joinRoom(selected);
      onOpenChange(false);
    } catch {
      alert("Failed to join room");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Join a Room</DialogTitle>
          <DialogDescription>
            Select a room to join from the available rooms.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[240px] overflow-y-auto border rounded-md">
          <div className="space-y-1 p-2">
            {rooms.length === 0 && (
              <p className="text-sm text-muted-foreground px-2 py-4 text-center">
                No available rooms to join
              </p>
            )}
            {rooms.map((room) => (
              <button
                key={room.room_id}
                className={`w-full text-left rounded-md px-3 py-2 text-sm transition-colors cursor-pointer ${
                  selected === room.room_id
                    ? "bg-accent"
                    : "hover:bg-accent/50"
                }`}
                onClick={() => setSelected(room.room_id)}
              >
                <div className="font-medium">{room.name}</div>
                <div className="text-xs text-muted-foreground">
                  {room.member_count} member{room.member_count !== 1 ? "s" : ""}
                </div>
              </button>
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleJoin} disabled={!selected || loading}>
            {loading ? "Joining..." : "Join Room"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
