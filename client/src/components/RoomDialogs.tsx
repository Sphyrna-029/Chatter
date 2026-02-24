import { useState, useEffect, useRef, useMemo } from "react";
import { useAppContext } from "@/lib/store";
import { apiUploadFile, apiCreateInvite, apiListInvites, apiDeleteInvite, apiDeleteRoom, type RoomSummary } from "@/lib/api";
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
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { X, ArrowUpDown, Search, ImagePlus, Settings, Copy, Trash2, Link, Lock, Eye, EyeOff, MessageSquare, LayoutList, PenTool } from "lucide-react";

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
  const [unlisted, setUnlisted] = useState(false);
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [roomType, setRoomType] = useState<"text" | "forum" | "whiteboard">("text");
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
      await createRoom(name, topic, tags.length > 0 ? tags : undefined, iconUrl, unlisted || undefined, password || undefined, roomType !== "text" ? roomType : undefined);
      setName("");
      setTopic("");
      setTags([]);
      setTagInput("");
      setIconFile(null);
      setIconPreview(null);
      setUnlisted(false);
      setPassword("");
      setRoomType("text");
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
            <Label>Room Type</Label>
            <ToggleGroup
              type="single"
              value={roomType}
              onValueChange={(val) => { if (val) setRoomType(val as "text" | "forum" | "whiteboard"); }}
              className="w-full rounded-md border border-border p-0.5 bg-muted"
            >
              <ToggleGroupItem
                value="text"
                className="flex-1 text-xs h-8 gap-1.5 data-[state=on]:bg-background data-[state=on]:shadow-sm rounded-sm"
              >
                <MessageSquare className="w-3.5 h-3.5" />
                Text Chat
              </ToggleGroupItem>
              <ToggleGroupItem
                value="forum"
                className="flex-1 text-xs h-8 gap-1.5 data-[state=on]:bg-background data-[state=on]:shadow-sm rounded-sm"
              >
                <LayoutList className="w-3.5 h-3.5" />
                Forum
              </ToggleGroupItem>
              <ToggleGroupItem
                value="whiteboard"
                className="flex-1 text-xs h-8 gap-1.5 data-[state=on]:bg-background data-[state=on]:shadow-sm rounded-sm"
              >
                <PenTool className="w-3.5 h-3.5" />
                Whiteboard
              </ToggleGroupItem>
            </ToggleGroup>
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
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Unlisted</Label>
              <p className="text-xs text-muted-foreground">Hidden from the public room list</p>
            </div>
            <Switch checked={unlisted} onCheckedChange={setUnlisted} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="room-password">Password (Optional)</Label>
            <div className="relative">
              <Input
                id="room-password"
                type={showPassword ? "text" : "password"}
                placeholder="Set a room password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button
                type="button"
                className="absolute right-2 top-2.5 text-muted-foreground hover:text-foreground cursor-pointer"
                onClick={() => setShowPassword(!showPassword)}
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
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
  const [password, setPassword] = useState("");
  const [joinError, setJoinError] = useState("");

  useEffect(() => {
    if (open) {
      setSearch("");
      setSortDesc(true);
      setPassword("");
      setJoinError("");
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

  const selectedRoom = rooms.find((r) => r.room_id === selected);

  const handleJoin = async () => {
    if (!selected) return;
    setLoading(true);
    setJoinError("");
    try {
      await joinRoom(selected, password || undefined);
      onOpenChange(false);
    } catch (e: any) {
      setJoinError(e.message || "Failed to join room");
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
                onClick={() => { setSelected(room.room_id); setPassword(""); setJoinError(""); }}
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
                    <div className="font-medium truncate flex items-center gap-1.5">
                      {room.name}
                      {room.has_password && <Lock className="w-3 h-3 text-muted-foreground shrink-0" />}
                    </div>
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
        {selectedRoom?.has_password && (
          <div className="space-y-2">
            <Label htmlFor="join-password" className="flex items-center gap-1.5">
              <Lock className="w-3.5 h-3.5" />
              This room requires a password
            </Label>
            <Input
              id="join-password"
              type="password"
              placeholder="Enter room password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); setJoinError(""); }}
              onKeyDown={(e) => e.key === "Enter" && handleJoin()}
            />
          </div>
        )}
        {joinError && (
          <p className="text-sm text-destructive">{joinError}</p>
        )}
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
  const [emojiAliases, setEmojiAliases] = useState<Record<string, string>>({});
  const [aliasNameInput, setAliasNameInput] = useState("");
  const [aliasValueInput, setAliasValueInput] = useState("");
  const [invites, setInvites] = useState<{ code: string; click_count: number; created_at: number }[]>([]);
  const [inviteLoading, setInviteLoading] = useState(false);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [iconFile, setIconFile] = useState<File | null>(null);
  const [iconPreview, setIconPreview] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [deleteConfirmName, setDeleteConfirmName] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [settingsUnlisted, setSettingsUnlisted] = useState(false);
  const [settingsPassword, setSettingsPassword] = useState("");
  const [showSettingsPassword, setShowSettingsPassword] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const emojiFileInputRef = useRef<HTMLInputElement>(null);

  const isOwner = info?.creator === state.userId;

  // Pre-populate when dialog opens
  useEffect(() => {
    if (open && info) {
      setName(info.name || "");
      setTags(info.tags || []);
      setTagInput("");
      setCustomEmojis(info.custom_emojis || []);
      setEmojiInput("");
      setEmojiAliases(info.emoji_aliases || {});
      setAliasNameInput("");
      setAliasValueInput("");
      setIconFile(null);
      setIconPreview(info.icon_url || null);
      setInvites([]);
      setCopiedCode(null);
      setDeleteConfirmName("");
      setSettingsUnlisted(info.unlisted || false);
      setSettingsPassword("");
      setShowSettingsPassword(false);
      if (isOwner) {
        apiListInvites(roomId).then((data) => setInvites(data.invites)).catch(() => {});
      }
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
      const settings: { name?: string; icon_url?: string; tags?: string[]; custom_emojis?: string[]; emoji_aliases?: Record<string, string>; unlisted?: boolean; password?: string; remove_password?: boolean } = {};
      if (name !== info?.name) settings.name = name;
      if (iconUrl !== undefined) settings.icon_url = iconUrl;
      const infoTags = info?.tags || [];
      if (JSON.stringify(tags) !== JSON.stringify(infoTags)) settings.tags = tags;
      const infoEmojis = info?.custom_emojis || [];
      if (JSON.stringify(customEmojis) !== JSON.stringify(infoEmojis)) settings.custom_emojis = customEmojis;
      const infoAliases = info?.emoji_aliases || {};
      if (JSON.stringify(emojiAliases) !== JSON.stringify(infoAliases)) settings.emoji_aliases = emojiAliases;
      if (settingsUnlisted !== (info?.unlisted || false)) settings.unlisted = settingsUnlisted;
      if (settingsPassword) settings.password = settingsPassword;
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

  const addAlias = () => {
    const name = aliasNameInput.trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
    const value = aliasValueInput.trim();
    if (name && value) {
      setEmojiAliases((prev) => ({ ...prev, [name]: value }));
    }
    setAliasNameInput("");
    setAliasValueInput("");
  };

  const removeAlias = (name: string) => {
    setEmojiAliases((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
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
          <div className="space-y-2">
            <Label>Emoji Aliases</Label>
            <p className="text-xs text-muted-foreground">Map shortcodes like :salute: to an emoji or custom image</p>
            <div className="flex gap-2">
              <Input
                placeholder="Alias name"
                value={aliasNameInput}
                onChange={(e) => setAliasNameInput(e.target.value)}
                className="flex-1"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addAlias();
                  }
                }}
              />
              <Input
                placeholder="Emoji or URL"
                value={aliasValueInput}
                onChange={(e) => setAliasValueInput(e.target.value)}
                className="flex-1"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addAlias();
                  }
                }}
              />
              <Button type="button" variant="outline" size="sm" onClick={addAlias} disabled={!aliasNameInput.trim() || !aliasValueInput.trim()}>
                Add
              </Button>
            </div>
            {customEmojis.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Or pick from room emojis:</p>
                <div className="flex flex-wrap gap-1">
                  {customEmojis.filter((e) => e.startsWith("/") || e.startsWith("http")).map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      className="h-7 w-7 rounded border border-border flex items-center justify-center hover:bg-accent/50 cursor-pointer"
                      onClick={() => setAliasValueInput(emoji)}
                      title="Click to use as alias value"
                    >
                      <img src={emoji} alt="emoji" className="w-5 h-5 object-contain" />
                    </button>
                  ))}
                </div>
              </div>
            )}
            {Object.keys(emojiAliases).length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {Object.entries(emojiAliases).map(([name, value]) => {
                  const isUrl = value.startsWith("/") || value.startsWith("http");
                  return (
                    <Badge key={name} variant="secondary" className="gap-1 pr-1">
                      <span className="text-xs font-mono">:{name}:</span>
                      <span className="mx-0.5">{isUrl ? <img src={value} alt={name} className="w-4 h-4 object-contain inline" /> : value}</span>
                      <button
                        type="button"
                        onClick={() => removeAlias(name)}
                        className="ml-0.5 hover:text-destructive cursor-pointer"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </Badge>
                  );
                })}
              </div>
            )}
          </div>
          {isOwner && (
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label>Unlisted</Label>
                <p className="text-xs text-muted-foreground">Hidden from the public room list</p>
              </div>
              <Switch checked={settingsUnlisted} onCheckedChange={setSettingsUnlisted} />
            </div>
          )}
          {isOwner && (
            <div className="space-y-2">
              <Label className="flex items-center gap-1.5">
                <Lock className="w-3.5 h-3.5" />
                Password Protection
              </Label>
              {info?.has_password ? (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">This room is currently password-protected.</p>
                  <div className="relative">
                    <Input
                      type={showSettingsPassword ? "text" : "password"}
                      placeholder="Change password (leave empty to keep)"
                      value={settingsPassword}
                      onChange={(e) => setSettingsPassword(e.target.value)}
                    />
                    <button
                      type="button"
                      className="absolute right-2 top-2.5 text-muted-foreground hover:text-foreground cursor-pointer"
                      onClick={() => setShowSettingsPassword(!showSettingsPassword)}
                    >
                      {showSettingsPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={async () => {
                      try {
                        await updateRoomSettings(roomId, { remove_password: true });
                      } catch (e: any) {
                        alert(e.message || "Failed to remove password");
                      }
                    }}
                  >
                    Remove Password
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">No password set. Add one to require a password to join.</p>
                  <div className="relative">
                    <Input
                      type={showSettingsPassword ? "text" : "password"}
                      placeholder="Set a password"
                      value={settingsPassword}
                      onChange={(e) => setSettingsPassword(e.target.value)}
                    />
                    <button
                      type="button"
                      className="absolute right-2 top-2.5 text-muted-foreground hover:text-foreground cursor-pointer"
                      onClick={() => setShowSettingsPassword(!showSettingsPassword)}
                    >
                      {showSettingsPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
          {isOwner && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="flex items-center gap-1.5">
                  <Link className="w-3.5 h-3.5" />
                  Invite Links
                </Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={inviteLoading}
                  onClick={async () => {
                    setInviteLoading(true);
                    try {
                      const { code } = await apiCreateInvite(roomId);
                      setInvites((prev) => [...prev, { code, click_count: 0, created_at: Date.now() }]);
                    } catch (e: any) {
                      alert(e.message || "Failed to create invite");
                    } finally {
                      setInviteLoading(false);
                    }
                  }}
                >
                  {inviteLoading ? "Creating..." : "Create Invite"}
                </Button>
              </div>
              {invites.length > 0 && (
                <div className="space-y-2 max-h-[160px] overflow-y-auto">
                  {invites.map((inv) => {
                    const url = `${window.location.origin}/invite/${inv.code}`;
                    return (
                      <div
                        key={inv.code}
                        className="flex items-center gap-2 p-2 rounded-md border text-sm bg-muted/30"
                      >
                        <div className="flex-1 min-w-0 truncate font-mono text-xs text-muted-foreground">
                          {url}
                        </div>
                        <span className="text-[10px] text-muted-foreground shrink-0">
                          {inv.click_count} click{inv.click_count !== 1 ? "s" : ""}
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 shrink-0"
                          title="Copy link"
                          onClick={() => {
                            navigator.clipboard.writeText(url);
                            setCopiedCode(inv.code);
                            setTimeout(() => setCopiedCode(null), 2000);
                          }}
                        >
                          {copiedCode === inv.code ? (
                            <span className="text-[10px] text-green-400">ok</span>
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 shrink-0 hover:text-destructive"
                          title="Delete invite"
                          onClick={async () => {
                            try {
                              await apiDeleteInvite(inv.code);
                              setInvites((prev) => prev.filter((i) => i.code !== inv.code));
                            } catch {
                              alert("Failed to delete invite");
                            }
                          }}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          {isOwner && (
            <div className="space-y-2 border-t pt-4">
              <Label className="text-destructive">Danger Zone</Label>
              <p className="text-xs text-muted-foreground">
                Deleting a room is permanent. Type the room name <span className="font-semibold text-foreground">{info?.name}</span> to confirm.
              </p>
              <Input
                placeholder="Enter room name to confirm"
                value={deleteConfirmName}
                onChange={(e) => setDeleteConfirmName(e.target.value)}
                className="text-sm"
              />
              <Button
                variant="destructive"
                className="w-full"
                disabled={deleteConfirmName !== info?.name || deleting}
                onClick={async () => {
                  setDeleting(true);
                  try {
                    await apiDeleteRoom(roomId);
                    onOpenChange(false);
                  } catch (e: any) {
                    alert(e.message || "Failed to delete room");
                  } finally {
                    setDeleting(false);
                  }
                }}
              >
                {deleting ? "Deleting..." : "Delete Room"}
              </Button>
            </div>
          )}
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
