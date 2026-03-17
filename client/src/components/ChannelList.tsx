import { useState, useRef, useCallback, useEffect } from "react";
import type { ConnectionQuality, ConnQualityData } from "./VoiceControls";
import { useAppContext } from "@/lib/store";
import {
  Hash, Volume2, Volume1, VolumeX, Plus, Pencil, Trash2, ChevronDown, ChevronRight,
  Mic, MicOff, PhoneOff, Monitor, FolderPlus, GripVertical,
} from "lucide-react";
import { displayUserId } from "@/lib/utils";
import {
  apiCreateCategory, apiUpdateCategory, apiDeleteCategory,
  apiUpdateChannel,
} from "@/lib/api";
import type { Channel, ChannelCategory } from "@/lib/api";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";

interface ChannelListProps {
  onJoinVoiceChannel: (channelId: string) => void;
  onLeaveVoice?: () => void;
  onToggleMute?: () => void;
  onToggleScreenShare?: () => void;
  isScreenSharing?: boolean;
  connQualityRef?: React.MutableRefObject<ConnQualityData>;
  setUserVolumeRef?: React.MutableRefObject<((userId: string, vol: number) => void) | null>;
}

function SignalBars({ quality, pingMs }: { quality: ConnectionQuality; pingMs: number | null }) {
  const colors = ["text-muted-foreground", "text-red-400", "text-orange-400", "text-green-400", "text-green-400"];
  const color = colors[quality];
  const tooltip = pingMs != null ? `${pingMs} ms` : "Connecting...";
  return (
    <svg width="16" height="14" viewBox="0 0 16 14" className={`shrink-0 ${color}`} fill="currentColor">
      <title>{tooltip}</title>
      <rect x="0" y="10" width="3" height="4" rx="0.5" opacity={quality >= 1 ? 1 : 0.3} />
      <rect x="4.5" y="7" width="3" height="7" rx="0.5" opacity={quality >= 2 ? 1 : 0.3} />
      <rect x="9" y="3.5" width="3" height="10.5" rx="0.5" opacity={quality >= 3 ? 1 : 0.3} />
      <rect x="13" y="0" width="3" height="14" rx="0.5" opacity={quality >= 4 ? 1 : 0.3} />
    </svg>
  );
}

export function ChannelList({ onJoinVoiceChannel, onLeaveVoice, onToggleMute, onToggleScreenShare, isScreenSharing, connQualityRef, setUserVolumeRef }: ChannelListProps) {
  const { state, dispatch, selectChannel, createChannel, updateChannel, deleteChannel } = useAppContext();
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editChannelId, setEditChannelId] = useState<string | null>(null);
  const [editReadOnly, setEditReadOnly] = useState(false);
  const [name, setName] = useState("");
  const [channelType, setChannelType] = useState<"text" | "voice">("text");
  const [topic, setTopic] = useState("");
  const [createCategoryId, setCreateCategoryId] = useState("");

  // Connection quality polling
  const [connData, setConnData] = useState<ConnQualityData>({ quality: 0, pingMs: null });
  useEffect(() => {
    if (!state.inVoiceChannel || !connQualityRef) return;
    const id = setInterval(() => setConnData(connQualityRef.current), 2000);
    return () => clearInterval(id);
  }, [state.inVoiceChannel, connQualityRef]);

  // Per-user local volume (0-1) and expanded volume control
  const [userVolumes, setUserVolumes] = useState<Record<string, number>>({});
  const [expandedUser, setExpandedUser] = useState<string | null>(null);

  const handleVolumeChange = useCallback((userId: string, vol: number) => {
    setUserVolumes((prev) => ({ ...prev, [userId]: vol }));
    setUserVolumeRef?.current?.(userId, vol);
  }, [setUserVolumeRef]);

  const toggleLocalMute = useCallback((userId: string) => {
    const current = userVolumes[userId] ?? 1;
    const newVol = current > 0 ? 0 : 1;
    handleVolumeChange(userId, newVol);
  }, [userVolumes, handleVolumeChange]);

  // Category dialogs
  const [categoryCreateOpen, setCategoryCreateOpen] = useState(false);
  const [categoryEditOpen, setCategoryEditOpen] = useState(false);
  const [categoryName, setCategoryName] = useState("");
  const [editCategoryId, setEditCategoryId] = useState<string | null>(null);

  // Collapsed categories
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());

  // Drag state
  const [dragChannelId, setDragChannelId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ categoryId: string } | null>(null);

  const roomId = state.currentRoomId;
  if (!roomId) return null;

  const roomInfo = state.roomInfoMap[roomId];
  if (roomInfo?.is_direct) return null;

  const myMember = state.roomMembers.find((m) => m.userId === state.userId);
  const canManage = myMember?.role === "owner" || myMember?.role === "moderator";

  const categories = [...state.channelCategories].sort((a, b) => a.position - b.position);
  const channels = state.channels;

  // Group channels by category
  const uncategorized = channels.filter((c) => !c.category_id);
  const channelsByCategory: Record<string, Channel[]> = {};
  for (const cat of categories) {
    channelsByCategory[cat.category_id] = channels
      .filter((c) => c.category_id === cat.category_id)
      .sort((a, b) => a.position - b.position);
  }

  const toggleCategory = (catId: string) => {
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(catId)) next.delete(catId);
      else next.add(catId);
      return next;
    });
  };

  // ─── Channel CRUD ──────────────────────────────────────────────────────
  const handleCreate = async () => {
    if (!name.trim() || !roomId) return;
    try {
      await createChannel(roomId, name.trim(), channelType, topic.trim() || undefined, createCategoryId || undefined);
      // If we had a category selected, move the channel into it after creation
      // The createChannel API already supports category_id via the provider
      setCreateOpen(false);
      setName("");
      setTopic("");
      setChannelType("text");
      setCreateCategoryId("");
    } catch (err: any) {
      alert(err.message || "Failed to create channel");
    }
  };

  const handleEdit = async () => {
    if (!editChannelId || !roomId) return;
    try {
      await updateChannel(roomId, editChannelId, { name: name.trim() || undefined, topic: topic.trim(), read_only: editReadOnly });
      setEditOpen(false);
      setEditChannelId(null);
      setName("");
      setTopic("");
    } catch (err: any) {
      alert(err.message || "Failed to update channel");
    }
  };

  const handleDelete = async (channelId: string) => {
    if (!roomId) return;
    if (!confirm("Delete this channel?")) return;
    try {
      await deleteChannel(roomId, channelId);
    } catch (err: any) {
      alert(err.message || "Failed to delete channel");
    }
  };

  const openEditDialog = (ch: Channel) => {
    setEditChannelId(ch.channel_id);
    setName(ch.name);
    setTopic(ch.topic || "");
    setEditReadOnly(ch.read_only ?? false);
    setEditOpen(true);
  };

  // ─── Category CRUD ─────────────────────────────────────────────────────
  const handleCreateCategory = async () => {
    if (!categoryName.trim() || !roomId) return;
    try {
      await apiCreateCategory(roomId, categoryName.trim());
      setCategoryCreateOpen(false);
      setCategoryName("");
    } catch (err: any) {
      alert(err.message || "Failed to create category");
    }
  };

  const handleEditCategory = async () => {
    if (!editCategoryId || !categoryName.trim() || !roomId) return;
    try {
      await apiUpdateCategory(roomId, editCategoryId, { name: categoryName.trim() });
      setCategoryEditOpen(false);
      setEditCategoryId(null);
      setCategoryName("");
    } catch (err: any) {
      alert(err.message || "Failed to update category");
    }
  };

  const handleDeleteCategory = async (categoryId: string) => {
    if (!roomId) return;
    if (!confirm("Delete this category? Channels will become uncategorized.")) return;
    try {
      await apiDeleteCategory(roomId, categoryId);
    } catch (err: any) {
      alert(err.message || "Failed to delete category");
    }
  };

  // ─── Drag & drop ───────────────────────────────────────────────────────
  const handleDragStart = (e: React.DragEvent, channelId: string) => {
    if (!canManage) return;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", channelId);
    setDragChannelId(channelId);
  };

  const handleDragOver = (e: React.DragEvent, categoryId: string) => {
    if (!canManage) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropTarget({ categoryId });
  };

  const handleDragLeave = () => {
    setDropTarget(null);
  };

  const handleDrop = async (e: React.DragEvent, categoryId: string) => {
    e.preventDefault();
    setDropTarget(null);
    setDragChannelId(null);
    const channelId = e.dataTransfer.getData("text/plain");
    if (!channelId || !roomId) return;

    const ch = channels.find((c) => c.channel_id === channelId);
    if (!ch || ch.category_id === categoryId) return;

    try {
      await apiUpdateChannel(roomId, channelId, { category_id: categoryId });
      dispatch({
        type: "UPDATE_CHANNEL",
        payload: { channel_id: channelId, category_id: categoryId },
      });
    } catch (err: any) {
      alert(err.message || "Failed to move channel");
    }
  };

  const handleDragEnd = () => {
    setDragChannelId(null);
    setDropTarget(null);
  };

  // ─── Render helpers ────────────────────────────────────────────────────
  const renderChannel = (ch: Channel) => {
    const isVoice = ch.channel_type === "voice";
    const members = isVoice ? (state.voiceChannelMembers[ch.channel_id] || []) : [];

    return (
      <div key={ch.channel_id} onDragEnd={handleDragEnd} className="mt-1">
        <div
          draggable={canManage}
          onDragStart={(e) => handleDragStart(e, ch.channel_id)}
          className={dragChannelId === ch.channel_id ? "opacity-40" : ""}
        >
          <ChannelItem
            channel={ch}
            isSelected={isVoice ? state.voiceChannelId === ch.channel_id : state.currentChannelId === ch.channel_id}
            canManage={canManage}
            hasUnread={!isVoice && (state.channelUnreadCounts[ch.channel_id] || 0) > 0}
            mentionCount={!isVoice ? (state.channelMentions[ch.channel_id] || 0) : 0}
            onSelect={() => {
              if (isVoice) {
                onJoinVoiceChannel(ch.channel_id);
              } else {
                selectChannel(ch.channel_id);
              }
            }}
            onEdit={() => openEditDialog(ch)}
            onDelete={() => handleDelete(ch.channel_id)}
            icon={isVoice
              ? <Volume2 className="h-4 w-4 shrink-0 text-muted-foreground" />
              : <Hash className="h-4 w-4 shrink-0 text-muted-foreground" />
            }
            showGrip={canManage}
          />
        </div>
        {isVoice && members.length > 0 && (
          <div className="ml-7 space-y-0.5 pb-1">
            {members.map((m) => {
              const isMe = m.userId === state.userId;
              const localVol = userVolumes[m.userId] ?? 1;
              const isLocalMuted = localVol === 0;
              const isExpanded = expandedUser === m.userId;
              return (
                <div key={m.userId}>
                  <div
                    className={`flex items-center gap-1.5 px-1 py-0.5 text-sm text-muted-foreground rounded transition-colors ${!isMe ? "cursor-pointer hover:bg-accent/50" : ""}`}
                    onClick={() => !isMe && setExpandedUser(isExpanded ? null : m.userId)}
                  >
                    {isLocalMuted && !isMe
                      ? <MicOff className="h-3 w-3 shrink-0 text-yellow-400" />
                      : m.muted
                        ? <MicOff className="h-3 w-3 shrink-0 text-red-400" />
                        : <Mic className="h-3 w-3 shrink-0 text-green-400" />
                    }
                    <span className={`truncate ${isLocalMuted && !isMe ? "line-through opacity-50" : ""}`}>{displayUserId(m.userId)}</span>
                    {m.screen_sharing && (
                      <Monitor className="h-3 w-3 shrink-0 text-purple-400 ml-auto" />
                    )}
                  </div>
                  {isExpanded && !isMe && (
                    <div className="flex items-center gap-1.5 px-1 py-1 ml-3">
                      <button
                        onClick={() => toggleLocalMute(m.userId)}
                        className="shrink-0 p-0.5 rounded hover:bg-accent transition-colors"
                        title={isLocalMuted ? "Unmute for me" : "Mute for me"}
                      >
                        {isLocalMuted
                          ? <VolumeX className="h-3.5 w-3.5 text-red-400" />
                          : localVol < 0.5
                            ? <Volume1 className="h-3.5 w-3.5 text-muted-foreground" />
                            : <Volume2 className="h-3.5 w-3.5 text-muted-foreground" />
                        }
                      </button>
                      <input
                        type="range"
                        min="0"
                        max="100"
                        value={Math.round(localVol * 100)}
                        onChange={(e) => handleVolumeChange(m.userId, parseInt(e.target.value) / 100)}
                        className="flex-1 h-1 accent-primary cursor-pointer"
                      />
                      <span className="text-[10px] w-7 text-right tabular-nums text-muted-foreground">{Math.round(localVol * 100)}%</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  const renderCategorySection = (cat: ChannelCategory) => {
    const catChannels = channelsByCategory[cat.category_id] || [];
    const isCollapsed = collapsedCategories.has(cat.category_id);
    const isDropping = dropTarget?.categoryId === cat.category_id;

    return (
      <div
        key={cat.category_id}
        onDragOver={(e) => handleDragOver(e, cat.category_id)}
        onDragLeave={handleDragLeave}
        onDrop={(e) => handleDrop(e, cat.category_id)}
        className={isDropping ? "bg-primary/10 rounded-md transition-colors" : "transition-colors"}
      >
        <div className="group flex items-center gap-1 px-2 py-1 mt-3">
          <button
            onClick={() => toggleCategory(cat.category_id)}
            className="flex items-center gap-1 flex-1 min-w-0 text-left hover:text-foreground transition-colors"
          >
            {isCollapsed ? (
              <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
            ) : (
              <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
            )}
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground truncate">
              {cat.name}
            </span>
          </button>
          {canManage && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-accent transition-opacity text-muted-foreground">
                  <Pencil className="h-3 w-3" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-40">
                <DropdownMenuItem onClick={() => {
                  setCreateCategoryId(cat.category_id);
                  setChannelType("text");
                  setCreateOpen(true);
                }}>
                  <Plus className="h-3.5 w-3.5 mr-2" /> Add Channel
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => {
                  setEditCategoryId(cat.category_id);
                  setCategoryName(cat.name);
                  setCategoryEditOpen(true);
                }}>
                  <Pencil className="h-3.5 w-3.5 mr-2" /> Rename
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="text-destructive"
                  onClick={() => handleDeleteCategory(cat.category_id)}
                >
                  <Trash2 className="h-3.5 w-3.5 mr-2" /> Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        {!isCollapsed && catChannels.map(renderChannel)}
      </div>
    );
  };

  // ─── Resize handle ─────────────────────────────────────────────────────
  const [width, setWidth] = useState(() => {
    // Auto-size to fit room name: measure text width + padding for icons/buttons
    const name = roomInfo?.name || "Room";
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.font = "600 14px ui-sans-serif, system-ui, sans-serif"; // text-sm font-semibold
      const textW = ctx.measureText(name).width;
      // Add padding: 12px left + 12px right + ~60px for action buttons
      return Math.min(400, Math.max(180, Math.ceil(textW + 84)));
    }
    return 208;
  });
  const resizing = useRef(false);
  const manuallyResized = useRef(false);
  const startX = useRef(0);
  const startW = useRef(0);

  // Re-auto-size when switching rooms (unless user manually resized)
  useEffect(() => {
    if (manuallyResized.current) return;
    const name = roomInfo?.name || "Room";
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.font = "600 14px ui-sans-serif, system-ui, sans-serif";
      const textW = ctx.measureText(name).width;
      setWidth(Math.min(400, Math.max(180, Math.ceil(textW + 84))));
    }
  }, [roomInfo?.name]);

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizing.current = true;
    startX.current = e.clientX;
    startW.current = width;

    const onMove = (ev: MouseEvent) => {
      if (!resizing.current) return;
      const newW = Math.min(400, Math.max(140, startW.current + (ev.clientX - startX.current)));
      setWidth(newW);
    };
    const onUp = () => {
      resizing.current = false;
      manuallyResized.current = true;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, [width]);

  return (
    <div className="border-r flex flex-col h-full shrink-0 bg-sidebar relative" style={{ width }}>
      {/* Room name header */}
      <div className="flex items-center justify-between px-3 py-2 border-b">
        <span className="text-sm font-semibold truncate">{roomInfo?.name || "Room"}</span>
        {canManage && (
          <div className="flex items-center gap-0.5">
            <button
              onClick={() => setCategoryCreateOpen(true)}
              className="p-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
              title="Create category"
            >
              <FolderPlus className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => { setChannelType("text"); setCreateCategoryId(""); setCreateOpen(true); }}
              className="p-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
              title="Create channel"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>

      <ScrollArea className="flex-1">
        <div className="py-1">
          {/* Uncategorized channels — drop zone for removing from category */}
          <div
            onDragOver={(e) => handleDragOver(e, "")}
            onDragLeave={handleDragLeave}
            onDrop={(e) => handleDrop(e, "")}
            className={dropTarget?.categoryId === "" ? "bg-primary/10 rounded-md transition-colors" : "transition-colors"}
          >
            {uncategorized.length > 0 && uncategorized.map(renderChannel)}
          </div>

          {/* Categorized channels */}
          {categories.map(renderCategorySection)}
        </div>
      </ScrollArea>

      {/* Voice controls toolbar */}
      {state.inVoiceChannel && (
        <div className="border-t px-2 py-2 space-y-1.5 shrink-0">
          <div className="flex items-center gap-1 px-1">
            <div className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />
            <span className="text-xs text-green-400 font-medium truncate">
              Voice Connected
            </span>
          </div>
          <div className="flex items-center gap-1">
            <SignalBars quality={connData.quality} pingMs={connData.pingMs} />
            <button
              onClick={onToggleMute}
              className={`flex-1 flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
                state.isMuted
                  ? "bg-red-500/20 text-red-400 hover:bg-red-500/30"
                  : "bg-secondary text-secondary-foreground hover:bg-secondary/80"
              }`}
              title={state.isMuted ? "Unmute" : "Mute"}
            >
              {state.isMuted ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
            </button>
            {onToggleScreenShare && (
              <button
                onClick={onToggleScreenShare}
                className={`flex-1 flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
                  isScreenSharing
                    ? "bg-purple-500/20 text-purple-400 hover:bg-purple-500/30"
                    : "bg-secondary text-secondary-foreground hover:bg-secondary/80"
                }`}
                title={isScreenSharing ? "Stop sharing" : "Share screen"}
              >
                <Monitor className="h-3.5 w-3.5" />
              </button>
            )}
            <button
              onClick={onLeaveVoice}
              className="flex-1 flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
              title="Disconnect"
            >
              <PhoneOff className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Create channel dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Create Channel</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Type</Label>
              <div className="flex gap-2 mt-1">
                <Button
                  variant={channelType === "text" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setChannelType("text")}
                >
                  <Hash className="h-3.5 w-3.5 mr-1" /> Text
                </Button>
                <Button
                  variant={channelType === "voice" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setChannelType("voice")}
                >
                  <Volume2 className="h-3.5 w-3.5 mr-1" /> Voice
                </Button>
              </div>
            </div>
            <div>
              <Label>Name</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="channel-name"
                onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              />
            </div>
            <div>
              <Label>Topic (optional)</Label>
              <Input
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="What's this channel about?"
              />
            </div>
            {categories.length > 0 && (
              <div>
                <Label>Category</Label>
                <select
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  value={createCategoryId}
                  onChange={(e) => setCreateCategoryId(e.target.value)}
                >
                  <option value="">No category</option>
                  {categories.map((cat) => (
                    <option key={cat.category_id} value={cat.category_id}>{cat.name}</option>
                  ))}
                </select>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={!name.trim()}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit channel dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Edit Channel</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Name</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleEdit()}
              />
            </div>
            <div>
              <Label>Topic</Label>
              <Input
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="Channel topic"
              />
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={editReadOnly}
                onChange={(e) => setEditReadOnly(e.target.checked)}
                className="rounded border-input"
              />
              <span className="text-sm">Read-only (only owners/moderators can post)</span>
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button onClick={handleEdit}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create category dialog */}
      <Dialog open={categoryCreateOpen} onOpenChange={setCategoryCreateOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Create Category</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Name</Label>
              <Input
                value={categoryName}
                onChange={(e) => setCategoryName(e.target.value)}
                placeholder="Category name"
                onKeyDown={(e) => e.key === "Enter" && handleCreateCategory()}
                autoFocus
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCategoryCreateOpen(false)}>Cancel</Button>
            <Button onClick={handleCreateCategory} disabled={!categoryName.trim()}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit category dialog */}
      <Dialog open={categoryEditOpen} onOpenChange={setCategoryEditOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename Category</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Name</Label>
              <Input
                value={categoryName}
                onChange={(e) => setCategoryName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleEditCategory()}
                autoFocus
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCategoryEditOpen(false)}>Cancel</Button>
            <Button onClick={handleEditCategory} disabled={!categoryName.trim()}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Resize handle */}
      <div
        onMouseDown={onResizeStart}
        className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-primary/30 active:bg-primary/50 transition-colors"
      />
    </div>
  );
}

function ChannelItem({
  channel,
  isSelected,
  canManage,
  hasUnread,
  mentionCount,
  onSelect,
  onEdit,
  onDelete,
  icon,
  showGrip,
}: {
  channel: { channel_id: string; name: string; topic?: string };
  isSelected: boolean;
  canManage: boolean;
  hasUnread?: boolean;
  mentionCount?: number;
  onSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
  icon: React.ReactNode;
  showGrip?: boolean;
}) {
  const unreadHighlight = !isSelected && hasUnread;
  return (
    <div
      className={`group flex items-center gap-1 px-2 py-1 mx-1 rounded cursor-pointer transition-colors ${
        isSelected
          ? "bg-accent text-accent-foreground"
          : unreadHighlight
            ? "text-foreground font-medium hover:bg-accent/50"
            : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
      }`}
      onClick={onSelect}
      title={channel.topic || channel.name}
    >
      {showGrip && (
        <GripVertical className="h-3 w-3 shrink-0 opacity-0 group-hover:opacity-50 cursor-grab" />
      )}
      {icon}
      <span className="truncate text-sm">{channel.name}</span>
      {(mentionCount ?? 0) > 0 && (
        <span className="ml-auto flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold leading-none text-white shrink-0">
          {mentionCount! > 99 ? "99+" : mentionCount}
        </span>
      )}
      {canManage && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
            <button className={`${(mentionCount ?? 0) > 0 ? "" : "ml-auto"} p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-accent transition-opacity`}>
              <Pencil className="h-3 w-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-32">
            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onEdit(); }}>
              <Pencil className="h-3.5 w-3.5 mr-2" /> Edit
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-destructive"
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
            >
              <Trash2 className="h-3.5 w-3.5 mr-2" /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
