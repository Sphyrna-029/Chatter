import { useState, useEffect, useRef, useMemo } from "react";
import { useAppContext } from "@/lib/store";
import { apiUploadFile, type RoomSummary } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { X, ArrowUpDown, Search, ImagePlus, Settings } from "lucide-react";

interface CreateRoomDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateRoomDialog({ open, onOpenChange }: CreateRoomDialogProps) {
  const { createRoom } = useAppContext();
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [iconFile, setIconFile] = useState<File | null>(null);
  const [iconPreview, setIconPreview] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleCreate = async () => {
    if (!name) return;
    setLoading(true);
    try {
      let iconUrl: string | undefined;
      if (iconFile) {
        const uploaded = await apiUploadFile(iconFile);
        iconUrl = uploaded.url;
      }
      await createRoom(name, topic, tags.length > 0 ? tags : undefined, iconUrl);
      setName("");
      setTopic("");
      setTags([]);
      setTagInput("");
      setIconFile(null);
      setIconPreview(null);
      onOpenChange(false);
    } catch {
      alert("Failed to create room");
    } finally {
      setLoading(false);
    }
  };

  const addTag = () => {
    const trimmed = tagInput.trim().toLowerCase();
    if (trimmed && !tags.includes(trimmed)) {
      setTags([...tags, trimmed]);
    }
    setTagInput("");
  };

  const removeTag = (tag: string) => {
    setTags(tags.filter((t) => t !== tag));
  };

  const handleIconSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setIconFile(file);
      const reader = new FileReader();
      reader.onload = () => setIconPreview(reader.result as string);
      reader.readAsDataURL(file);
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
          <div className="flex items-start gap-4">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="shrink-0 w-16 h-16 rounded-full border-2 border-dashed border-muted-foreground/30 flex items-center justify-center overflow-hidden hover:border-muted-foreground/60 transition-colors cursor-pointer"
            >
              {iconPreview ? (
                <img src={iconPreview} alt="Room icon" className="w-full h-full object-cover" />
              ) : (
                <ImagePlus className="w-5 h-5 text-muted-foreground" />
              )}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleIconSelect}
            />
            <div className="flex-1 space-y-2">
              <Label htmlFor="room-name">Room Name</Label>
              <Input
                id="room-name"
                placeholder="My Awesome Room"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              />
            </div>
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
          <div className="space-y-2">
            <Label htmlFor="room-tags">Tags (Optional)</Label>
            <div className="flex gap-2">
              <Input
                id="room-tags"
                placeholder="Add a tag and press Enter"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addTag();
                  }
                }}
              />
              <Button type="button" variant="outline" size="sm" onClick={addTag} disabled={!tagInput.trim()}>
                Add
              </Button>
            </div>
            {tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {tags.map((tag) => (
                  <Badge key={tag} variant="secondary" className="gap-1 pr-1">
                    {tag}
                    <button
                      type="button"
                      onClick={() => removeTag(tag)}
                      className="ml-0.5 hover:text-destructive cursor-pointer"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            )}
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
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [sortDesc, setSortDesc] = useState(true);

  useEffect(() => {
    if (open) {
      setSearch("");
      setSortDesc(true);
      getAllRooms().then((allRooms) => {
        const filtered = allRooms.filter(
          (r) => !state.joinedRoomIds.includes(r.room_id)
        );
        setRooms(filtered);
        setSelected(filtered[0]?.room_id || null);
      });
    }
  }, [open, state.joinedRoomIds, getAllRooms]);

  const filteredRooms = useMemo(() => {
    const q = search.toLowerCase();
    let result = rooms;
    if (q) {
      result = rooms.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          (r.tags && r.tags.some((t) => t.toLowerCase().includes(q)))
      );
    }
    result = [...result].sort((a, b) =>
      sortDesc ? b.member_count - a.member_count : a.member_count - b.member_count
    );
    return result;
  }, [rooms, search, sortDesc]);

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
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by name or tag..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
            />
          </div>
          <Button
            variant="outline"
            size="icon"
            onClick={() => setSortDesc(!sortDesc)}
            title={sortDesc ? "Sort: most members first" : "Sort: fewest members first"}
          >
            <ArrowUpDown className="h-4 w-4" />
          </Button>
        </div>
        <div className="max-h-[280px] overflow-y-auto border rounded-md">
          <div className="space-y-1 p-2">
            {filteredRooms.length === 0 && (
              <p className="text-sm text-muted-foreground px-2 py-4 text-center">
                {rooms.length === 0 ? "No available rooms to join" : "No rooms match your search"}
              </p>
            )}
            {filteredRooms.map((room) => (
              <button
                key={room.room_id}
                className={`w-full text-left rounded-md px-3 py-2 text-sm transition-colors cursor-pointer ${
                  selected === room.room_id
                    ? "bg-accent"
                    : "hover:bg-accent/50"
                }`}
                onClick={() => setSelected(room.room_id)}
              >
                <div className="flex items-center gap-2">
                  <div className="shrink-0 w-8 h-8 rounded-full bg-muted flex items-center justify-center overflow-hidden text-xs font-medium">
                    {room.icon_url ? (
                      <img src={room.icon_url} alt="" className="w-full h-full object-cover" />
                    ) : (
                      room.name.charAt(0).toUpperCase()
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{room.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {room.member_count} member{room.member_count !== 1 ? "s" : ""}
                    </div>
                  </div>
                </div>
                {room.tags && room.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1 ml-10">
                    {room.tags.map((tag) => (
                      <Badge key={tag} variant="outline" className="text-[10px] px-1.5 py-0">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                )}
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

interface RoomSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roomId: string;
}

export function RoomSettingsDialog({ open, onOpenChange, roomId }: RoomSettingsDialogProps) {
  const { state, updateRoomSettings } = useAppContext();
  const info = state.roomInfoMap[roomId];
  const [name, setName] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [customEmojis, setCustomEmojis] = useState<string[]>([]);
  const [emojiInput, setEmojiInput] = useState("");
  const [emojiUploading, setEmojiUploading] = useState(false);
  const [iconFile, setIconFile] = useState<File | null>(null);
  const [iconPreview, setIconPreview] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const emojiFileInputRef = useRef<HTMLInputElement>(null);

  // Pre-populate when dialog opens
  useEffect(() => {
    if (open && info) {
      setName(info.name || "");
      setTags(info.tags || []);
      setTagInput("");
      setCustomEmojis(info.custom_emojis || []);
      setEmojiInput("");
      setIconFile(null);
      setIconPreview(info.icon_url || null);
    }
  }, [open, roomId]);

  const handleSave = async () => {
    if (!name) return;
    setLoading(true);
    try {
      let iconUrl: string | undefined;
      if (iconFile) {
        const uploaded = await apiUploadFile(iconFile);
        iconUrl = uploaded.url;
      }
      const settings: { name?: string; icon_url?: string; tags?: string[]; custom_emojis?: string[] } = {};
      if (name !== info?.name) settings.name = name;
      if (iconUrl !== undefined) settings.icon_url = iconUrl;
      const infoTags = info?.tags || [];
      if (JSON.stringify(tags) !== JSON.stringify(infoTags)) settings.tags = tags;
      const infoEmojis = info?.custom_emojis || [];
      if (JSON.stringify(customEmojis) !== JSON.stringify(infoEmojis)) settings.custom_emojis = customEmojis;
      if (Object.keys(settings).length > 0) {
        await updateRoomSettings(roomId, settings);
      }
      onOpenChange(false);
    } catch (e: any) {
      alert(e.message || "Failed to update room settings");
    } finally {
      setLoading(false);
    }
  };

  const addTag = () => {
    const trimmed = tagInput.trim().toLowerCase();
    if (trimmed && !tags.includes(trimmed)) {
      setTags([...tags, trimmed]);
    }
    setTagInput("");
  };

  const removeTag = (tag: string) => {
    setTags(tags.filter((t) => t !== tag));
  };

  const addEmoji = () => {
    const trimmed = emojiInput.trim();
    if (trimmed && !customEmojis.includes(trimmed)) {
      setCustomEmojis([...customEmojis, trimmed]);
    }
    setEmojiInput("");
  };

  const removeEmoji = (emoji: string) => {
    setCustomEmojis(customEmojis.filter((e) => e !== emoji));
  };

  const handleEmojiFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setEmojiUploading(true);
    try {
      const { url } = await apiUploadFile(file);
      if (!customEmojis.includes(url)) {
        setCustomEmojis((prev) => [...prev, url]);
      }
    } catch {
      alert("Failed to upload emoji image");
    } finally {
      setEmojiUploading(false);
    }
  };

  const handleIconSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setIconFile(file);
      const reader = new FileReader();
      reader.onload = () => setIconPreview(reader.result as string);
      reader.readAsDataURL(file);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Room Settings</DialogTitle>
          <DialogDescription>
            Edit the room name, icon, and tags.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="flex items-start gap-4">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="shrink-0 w-16 h-16 rounded-full border-2 border-dashed border-muted-foreground/30 flex items-center justify-center overflow-hidden hover:border-muted-foreground/60 transition-colors cursor-pointer"
            >
              {iconPreview ? (
                <img src={iconPreview} alt="Room icon" className="w-full h-full object-cover" />
              ) : (
                <ImagePlus className="w-5 h-5 text-muted-foreground" />
              )}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleIconSelect}
            />
            <div className="flex-1 space-y-2">
              <Label htmlFor="settings-room-name">Room Name</Label>
              <Input
                id="settings-room-name"
                placeholder="Room name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSave()}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="settings-room-tags">Tags</Label>
            <div className="flex gap-2">
              <Input
                id="settings-room-tags"
                placeholder="Add a tag and press Enter"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addTag();
                  }
                }}
              />
              <Button type="button" variant="outline" size="sm" onClick={addTag} disabled={!tagInput.trim()}>
                Add
              </Button>
            </div>
            {tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {tags.map((tag) => (
                  <Badge key={tag} variant="secondary" className="gap-1 pr-1">
                    {tag}
                    <button
                      type="button"
                      onClick={() => removeTag(tag)}
                      className="ml-0.5 hover:text-destructive cursor-pointer"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="settings-room-emojis">Room Emojis</Label>
            <div className="flex gap-2">
              <Input
                id="settings-room-emojis"
                placeholder="Paste a Unicode emoji and press Enter"
                value={emojiInput}
                onChange={(e) => setEmojiInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addEmoji();
                  }
                }}
              />
              <Button type="button" variant="outline" size="sm" onClick={addEmoji} disabled={!emojiInput.trim()}>
                Add
              </Button>
              <input
                ref={emojiFileInputRef}
                type="file"
                accept=".webp,.png,image/webp,image/png"
                className="hidden"
                onChange={handleEmojiFileSelect}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => emojiFileInputRef.current?.click()}
                disabled={emojiUploading}
                title="Upload .png or .webp image"
              >
                <ImagePlus className="w-4 h-4" />
              </Button>
            </div>
            {customEmojis.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {customEmojis.map((emoji) => (
                  <Badge key={emoji} variant="secondary" className="gap-1 pr-1 text-base">
                    {emoji.startsWith("/") || emoji.startsWith("http") ? (
                      <img src={emoji} alt="custom emoji" className="w-5 h-5 object-contain" />
                    ) : (
                      emoji
                    )}
                    <button
                      type="button"
                      onClick={() => removeEmoji(emoji)}
                      className="ml-0.5 hover:text-destructive cursor-pointer"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!name || loading}>
            {loading ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
