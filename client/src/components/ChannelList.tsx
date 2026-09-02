import { useState, useRef, useCallback, useEffect, useLayoutEffect } from "react";
import type { ConnectionQuality, ConnQualityData } from "./VoiceControls";
import { useAppContext } from "@/lib/store";
import {
  Hash, Volume2, Volume1, VolumeX, Plus, Pencil, Trash2, ChevronDown, ChevronRight,
  Mic, MicOff, PhoneOff, Monitor, HeadphoneOff, Camera, FolderPlus, GripVertical, PanelLeftClose, PanelLeftOpen, Lock, Shield, ImagePlus, X,
  Film, LayoutList, PenTool, Sparkles, Bot,
} from "lucide-react";
import { displayUserId } from "@/lib/utils";
import { AuthImage } from "./AuthImage";
import {
  apiCreateCategory, apiUpdateCategory, apiDeleteCategory,
  apiUpdateChannel, apiUploadFile, apiUpdateRoomSettings,
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
import { RoleManagementDialog } from "./RoleManagementDialog";

interface ChannelListProps {
  onJoinVoiceChannel: (channelId: string) => void;
  onLeaveVoice?: () => void;
  onToggleMute?: () => void;
  onToggleDeafen?: () => void;
  onToggleScreenShare?: () => void;
  isScreenSharing?: boolean;
  onToggleWebcam?: () => void;
  isWebcamActive?: boolean;
  connQualityRef?: React.MutableRefObject<ConnQualityData>;
  setUserVolumeRef?: React.MutableRefObject<((userId: string, vol: number) => void) | null>;
  speakingUsersRef?: React.MutableRefObject<Set<string>>;
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

function VoiceTimer({ since }: { since: number }) {
  const [elapsed, setElapsed] = useState(() => Date.now() - since);
  useEffect(() => {
    const id = setInterval(() => setElapsed(Date.now() - since), 1000);
    return () => clearInterval(id);
  }, [since]);
  const totalSecs = Math.floor(elapsed / 1000);
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  const str = h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
  return <span className="text-green-400 text-[10px] font-mono ml-1 shrink-0">{str}</span>;
}

export function ChannelList({ onJoinVoiceChannel, onLeaveVoice, onToggleMute, onToggleDeafen, onToggleScreenShare, isScreenSharing, onToggleWebcam, isWebcamActive, connQualityRef, setUserVolumeRef, speakingUsersRef }: ChannelListProps) {
  const { state, dispatch, selectChannel, createChannel, updateChannel, deleteChannel } = useAppContext();
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editChannelId, setEditChannelId] = useState<string | null>(null);
  const [editReadOnly, setEditReadOnly] = useState(false);
  const [editViewRoles, setEditViewRoles] = useState<string[]>([]);
  const [editWriteRoles, setEditWriteRoles] = useState<string[]>([]);
  const [editShowcaseWriteRoles, setEditShowcaseWriteRoles] = useState<string[]>([]);
  const [editChannelType, setEditChannelType] = useState<string>("");
  const [editSystemChannel, setEditSystemChannel] = useState(false);
  const [name, setName] = useState("");
  const [channelType, setChannelType] = useState<"text" | "voice" | "theater" | "forum" | "whiteboard" | "showcase">("text");
  const [topic, setTopic] = useState("");
  const [createCategoryId, setCreateCategoryId] = useState("");

  // Connection quality polling — initialize from the ref so remounts don't flash stale status
  const [connData, setConnData] = useState<ConnQualityData>(() =>
    connQualityRef?.current ?? { quality: 0, pingMs: null, status: "closed" }
  );
  // Sync immediately on mount (before paint) so we never render stale status
  useLayoutEffect(() => {
    if (connQualityRef) setConnData(connQualityRef.current);
  }, [connQualityRef]);
  useEffect(() => {
    if (!state.inVoiceChannel || !connQualityRef) return;
    setConnData(connQualityRef.current);
    const id = setInterval(() => setConnData(connQualityRef.current), 500);
    return () => clearInterval(id);
  }, [state.inVoiceChannel, connQualityRef]);

  // Speaking indicator polling
  const [speakingUsers, setSpeakingUsers] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!state.inVoiceChannel || !speakingUsersRef) return;
    const id = setInterval(() => setSpeakingUsers(new Set(speakingUsersRef.current)), 100);
    return () => clearInterval(id);
  }, [state.inVoiceChannel, speakingUsersRef]);

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
  // Roles dialog
  const [rolesOpen, setRolesOpen] = useState(false);
  // Banner upload
  const bannerInputRef = useRef<HTMLInputElement>(null);

  // Mobile collapse — default collapsed on small screens
  const [panelCollapsed, setPanelCollapsed] = useState(() => window.innerWidth < 768);

  // Drag state
  const [dragChannelId, setDragChannelId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ categoryId: string } | null>(null);
  const [dropChannelId, setDropChannelId] = useState<string | null>(null);
  const [dropSide, setDropSide] = useState<"before" | "after">("before");

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
      await apiUpdateChannel(roomId, editChannelId, {
        name: name.trim() || undefined,
        topic: topic.trim(),
        read_only: editReadOnly,
        view_roles: editViewRoles,
        write_roles: editWriteRoles,
        showcase_write_roles: editChannelType === "showcase" ? editShowcaseWriteRoles : undefined,
        system_channel: editSystemChannel,
      });
      dispatch({ type: "UPDATE_CHANNEL", payload: { channel_id: editChannelId, name: name.trim(), topic: topic.trim(), read_only: editReadOnly, view_roles: editViewRoles, write_roles: editWriteRoles, showcase_write_roles: editShowcaseWriteRoles, system_channel: editSystemChannel } });
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
    setEditViewRoles(ch.view_roles ?? []);
    setEditWriteRoles(ch.write_roles ?? []);
    setEditShowcaseWriteRoles(ch.showcase_write_roles ?? []);
    setEditChannelType(ch.channel_type);
    setEditSystemChannel(ch.system_channel ?? false);
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
    setDropChannelId(null);
  };

  const handleDragLeave = () => {
    setDropTarget(null);
  };

  const handleDrop = async (e: React.DragEvent, categoryId: string) => {
    e.preventDefault();
    setDropTarget(null);
    setDragChannelId(null);
    setDropChannelId(null);
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

  const handleChannelDragOver = (e: React.DragEvent, targetChannelId: string) => {
    if (!canManage || !dragChannelId || dragChannelId === targetChannelId) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    const rect = e.currentTarget.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    setDropSide(e.clientY < midY ? "before" : "after");
    setDropChannelId(targetChannelId);
    setDropTarget(null);
  };

  const handleChannelDragLeave = (e: React.DragEvent, channelId: string) => {
    if (dropChannelId === channelId && !e.currentTarget.contains(e.relatedTarget as Node)) {
      setDropChannelId(null);
    }
  };

  const handleChannelDrop = async (e: React.DragEvent, targetChannelId: string) => {
    e.preventDefault();
    e.stopPropagation();
    const srcId = e.dataTransfer.getData("text/plain");
    if (!srcId || srcId === targetChannelId || !roomId) {
      setDragChannelId(null);
      setDropChannelId(null);
      setDropTarget(null);
      return;
    }

    const srcChannel = channels.find((c) => c.channel_id === srcId);
    const targetChannel = channels.find((c) => c.channel_id === targetChannelId);
    if (!srcChannel || !targetChannel) return;

    const targetCatId = targetChannel.category_id || "";
    // Get siblings in the target category, sorted by position
    const siblings = channels
      .filter((c) => (c.category_id || "") === targetCatId && c.channel_id !== srcId)
      .sort((a, b) => a.position - b.position);

    const targetIdx = siblings.findIndex((c) => c.channel_id === targetChannelId);
    const insertIdx = dropSide === "before" ? targetIdx : targetIdx + 1;

    // Compute new positions for all channels in this category
    const reordered = [...siblings];
    reordered.splice(insertIdx, 0, srcChannel);

    try {
      // Update positions for all reordered channels + move category if needed
      const updates = reordered.map((ch, i) => {
        const update: { position?: number; category_id?: string } = {};
        if (ch.position !== i) update.position = i;
        if (ch.channel_id === srcId && (srcChannel.category_id || "") !== targetCatId) {
          update.category_id = targetCatId;
        }
        return { channelId: ch.channel_id, update };
      }).filter((u) => u.update.position !== undefined || u.update.category_id !== undefined);

      for (const { channelId, update } of updates) {
        await apiUpdateChannel(roomId, channelId, update);
        dispatch({
          type: "UPDATE_CHANNEL",
          payload: { channel_id: channelId, ...update },
        });
      }
    } catch (err: any) {
      alert(err.message || "Failed to reorder channel");
    }

    setDragChannelId(null);
    setDropChannelId(null);
    setDropTarget(null);
  };

  const handleDragEnd = () => {
    setDragChannelId(null);
    setDropTarget(null);
    setDropChannelId(null);
  };

  // ─── Render helpers ────────────────────────────────────────────────────
  const renderChannel = (ch: Channel) => {
    const isVoice = ch.channel_type === "voice";
    const members = isVoice ? (state.voiceChannelMembers[ch.channel_id] || []) : [];
    const occupiedSince = isVoice && members.length > 0 ? state.voiceChannelOccupiedSince[ch.channel_id] : undefined;

    return (
      <div key={ch.channel_id} onDragEnd={handleDragEnd} className="mt-1">
        <div
          draggable={canManage}
          onDragStart={(e) => handleDragStart(e, ch.channel_id)}
          onDragOver={(e) => handleChannelDragOver(e, ch.channel_id)}
          onDragLeave={(e) => handleChannelDragLeave(e, ch.channel_id)}
          onDrop={(e) => handleChannelDrop(e, ch.channel_id)}
          className={`${dragChannelId === ch.channel_id ? "opacity-40" : ""} ${
            dropChannelId === ch.channel_id && dropSide === "before" ? "border-t-2 border-t-primary" : ""
          } ${
            dropChannelId === ch.channel_id && dropSide === "after" ? "border-b-2 border-b-primary" : ""
          }`}
        >
          <ChannelItem
            channel={ch}
            isSelected={isVoice ? state.voiceChannelId === ch.channel_id : state.currentChannelId === ch.channel_id}
            canManage={canManage}
            hasUnread={!isVoice && ((state.channelUnreadCounts[ch.channel_id] || 0) > 0 || (state.channelMentions[ch.channel_id] || 0) > 0)}
            unreadCount={!isVoice ? (state.channelUnreadCounts[ch.channel_id] || 0) : 0}
            mentionCount={!isVoice ? (state.channelMentions[ch.channel_id] || 0) : 0}
            onSelect={() => {
              if (isVoice) {
                if (state.voiceChannelId === ch.channel_id) return;
                onJoinVoiceChannel(ch.channel_id);
              } else {
                selectChannel(ch.channel_id);
              }
            }}
            onEdit={() => openEditDialog(ch)}
            onDelete={() => handleDelete(ch.channel_id)}
            icon={(ch.view_roles?.length ?? 0) > 0
              ? <Lock className="h-4 w-4 shrink-0 text-yellow-500" />
              : ch.channel_type === "voice"
                ? <Volume2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                : ch.channel_type === "theater"
                  ? <Film className="h-4 w-4 shrink-0 text-muted-foreground" />
                  : ch.channel_type === "forum"
                    ? <LayoutList className="h-4 w-4 shrink-0 text-muted-foreground" />
                    : ch.channel_type === "whiteboard"
                      ? <PenTool className="h-4 w-4 shrink-0 text-muted-foreground" />
                      : ch.channel_type === "showcase"
                        ? <Sparkles className="h-4 w-4 shrink-0 text-muted-foreground" />
                        : ch.channel_type === "bot"
                          ? <Bot className="h-4 w-4 shrink-0 text-muted-foreground" />
                          : <Hash className="h-4 w-4 shrink-0 text-muted-foreground" />
            }
            showGrip={canManage}
            badge={occupiedSince ? <VoiceTimer since={occupiedSince} /> : undefined}
          />
        </div>
        {isVoice && members.length > 0 && (
          <div className="ml-7 space-y-0.5 pb-1">
            {members.map((m) => {
              const isMe = m.userId === state.userId;
              const localVol = userVolumes[m.userId] ?? 1;
              const isLocalMuted = localVol === 0;
              const isExpanded = expandedUser === m.userId;
              const isSpeaking = speakingUsers.has(m.userId) && !m.muted && !isLocalMuted;
              return (
                <div key={m.userId}>
                  <div
                    className={`flex items-center gap-1.5 px-1 py-0.5 text-sm rounded transition-colors ${isSpeaking ? "text-green-400 bg-green-500/10 shadow-[0_0_6px_1px_rgba(74,222,128,0.35)]" : "text-muted-foreground"} ${!isMe ? "cursor-pointer hover:bg-accent/50" : ""}`}
                    onClick={() => !isMe && setExpandedUser(isExpanded ? null : m.userId)}
                  >
                    {isLocalMuted && !isMe
                      ? <MicOff className="h-3 w-3 shrink-0 text-yellow-400" />
                      : m.muted || m.deafened
                        ? <MicOff className="h-3 w-3 shrink-0 text-red-400" />
                        : <Mic className="h-3 w-3 shrink-0 text-green-400" />
                    }
                    {m.deafened && (
                      <HeadphoneOff className="h-3 w-3 shrink-0 text-red-400" aria-label="Deafened" />
                    )}
                    <span className={`truncate ${isLocalMuted && !isMe ? "line-through opacity-50" : ""}`}>{state.userPresence[m.userId]?.displayName || displayUserId(m.userId)}</span>
                    <div className="ml-auto flex items-center gap-1 shrink-0">
                      {state.activeWebcamStreamers.includes(m.userId) && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            dispatch({ type: "SET_SCREEN_VIEWER", payload: { open: true } });
                          }}
                          className="shrink-0 p-0.5 rounded hover:bg-blue-500/20 transition-colors"
                          title={`${(state.userPresence[m.userId]?.displayName || displayUserId(m.userId))} is sharing their camera`}
                        >
                          <Camera className="h-3 w-3 text-blue-400" />
                        </button>
                      )}
                      {m.screen_sharing && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            dispatch({ type: "SET_SCREEN_VIEWER", payload: { open: true, sharer: m.userId } });
                          }}
                          className="shrink-0 p-0.5 rounded hover:bg-purple-500/20 transition-colors"
                          title={`Watch ${(state.userPresence[m.userId]?.displayName || displayUserId(m.userId))}'s screen`}
                        >
                          <Monitor className="h-3 w-3 text-purple-400" />
                        </button>
                      )}
                    </div>
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
    <div className="rounded-lg overflow-hidden border border-border bg-sidebar relative transition-[width] duration-200 mr-2 flex flex-col h-full shrink-0" style={{ width: panelCollapsed ? 40 : width }}>
      {/* Room name header */}
      <div className="flex items-center justify-between px-3 py-2 border-b">
        {panelCollapsed ? (
          <button
            onClick={() => setPanelCollapsed(false)}
            className="p-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors mx-auto"
            title="Show channels"
          >
            <PanelLeftOpen className="h-4 w-4" />
          </button>
        ) : (
          <>
            <span className="text-sm font-semibold truncate">{roomInfo?.name || "Room"}</span>
            <div className="flex items-center gap-0.5">
              {canManage && (
                <>
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
                  <button
                    onClick={() => setRolesOpen(true)}
                    className="p-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                    title="Manage roles"
                  >
                    <Shield className="h-3.5 w-3.5" />
                  </button>
                </>
              )}
              <button
                onClick={() => setPanelCollapsed(true)}
                className="p-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors md:hidden"
                title="Hide channels"
              >
                <PanelLeftClose className="h-3.5 w-3.5" />
              </button>
            </div>
          </>
        )}
      </div>

      {/* Room banner */}
      {!panelCollapsed && (
        <div className="relative shrink-0">
          {roomInfo?.banner_url ? (
            <div
              className={`relative h-24 overflow-hidden ${canManage ? "cursor-pointer" : ""}`}
              onClick={() => canManage && bannerInputRef.current?.click()}
            >
              <AuthImage
                src={roomInfo.banner_url}
                alt="Room banner"
                className="w-full h-full object-cover"
              />
              <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-sidebar" />
              {canManage && (
                <button
                  className="absolute top-1 right-1 p-0.5 rounded bg-black/50 text-white/70 hover:text-white opacity-0 hover:opacity-100 transition-opacity"
                  title="Remove banner"
                  onClick={async () => {
                    if (!roomId) return;
                    await apiUpdateRoomSettings(roomId, { banner_url: "" });
                    dispatch({ type: "UPDATE_ROOM_SETTINGS", payload: { roomId, banner_url: "" } });
                  }}
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          ) : canManage ? (
            <button
              className="w-full flex items-center justify-center gap-1 py-1.5 text-[10px] text-muted-foreground/50 hover:text-muted-foreground hover:bg-accent/30 transition-colors"
              onClick={() => bannerInputRef.current?.click()}
              title="Set room banner"
            >
              <ImagePlus className="h-3 w-3" /> Set Banner
            </button>
          ) : null}
          <input
            ref={bannerInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file || !roomId) return;
              e.target.value = "";
              try {
                const { url } = await apiUploadFile(file);
                await apiUpdateRoomSettings(roomId, { banner_url: url });
                dispatch({ type: "UPDATE_ROOM_SETTINGS", payload: { roomId, banner_url: url } });
              } catch (err: any) {
                alert(err.message || "Failed to upload banner");
              }
            }}
          />
        </div>
      )}

      <ScrollArea className={`flex-1 min-h-0 ${panelCollapsed ? "hidden" : ""}`}>
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
      {!panelCollapsed && state.inVoiceChannel && (
        <div className="border-t px-2 py-2 space-y-1.5 shrink-0">
          <div className="flex items-center gap-1 px-1">
            {(() => {
              // Derive effective status — treat "closed" as connected when we know we're in voice
              // (can happen briefly on ChannelList remount before the first poll)
              const s = connData.status === "closed" && state.inVoiceChannel ? "connected" : connData.status;
              const isOk = s === "connected";
              const isBad = s === "failed" || s === "disconnected";
              return (
                <>
                  <div className={`h-2 w-2 rounded-full ${
                    isOk ? "bg-green-500" : isBad ? "bg-red-500" : "bg-yellow-500"
                  } animate-pulse`} />
                  <span className={`text-xs font-medium truncate ${
                    isOk ? "text-green-400" : isBad ? "text-red-400" : "text-yellow-400"
                  }`}>
                    {isOk ? "Voice Connected" :
                     s === "connecting" || s === "new" ? "Connecting..." :
                     s === "failed" ? "Connection Failed" :
                     s === "disconnected" ? "Reconnecting..." :
                     "Voice Connected"}
                  </span>
                </>
              );
            })()}
          </div>
          <div className="flex items-center gap-1">
            <SignalBars quality={connData.quality} pingMs={connData.pingMs} />
            <button
              onClick={onToggleMute}
              disabled={state.isDeafened}
              className={`flex-1 flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
                state.isMuted || state.isDeafened
                  ? "bg-red-500/20 text-red-400 hover:bg-red-500/30"
                  : "bg-secondary text-secondary-foreground hover:bg-secondary/80"
              }`}
              title={state.isDeafened ? "Undeafen to unmute" : state.isMuted ? "Unmute" : "Mute"}
            >
              {state.isMuted || state.isDeafened ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
            </button>
            <button
              onClick={onToggleDeafen}
              className={`flex-1 flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
                state.isDeafened
                  ? "bg-red-500/20 text-red-400 hover:bg-red-500/30"
                  : "bg-secondary text-secondary-foreground hover:bg-secondary/80"
              }`}
              title={state.isDeafened ? "Undeafen" : "Deafen"}
            >
              <HeadphoneOff className="h-3.5 w-3.5" />
            </button>
            {onToggleWebcam && (
              <button
                onClick={onToggleWebcam}
                className={`flex-1 flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
                  isWebcamActive
                    ? "bg-green-500/20 text-green-400 hover:bg-green-500/30"
                    : "bg-secondary text-secondary-foreground hover:bg-secondary/80"
                }`}
                title={isWebcamActive ? "Stop camera" : "Share camera"}
              >
                <Camera className="h-3.5 w-3.5" />
              </button>
            )}
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
              <div className="grid grid-cols-3 gap-2 mt-1">
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
                <Button
                  variant={channelType === "theater" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setChannelType("theater")}
                >
                  <Film className="h-3.5 w-3.5 mr-1" /> Theater
                </Button>
                <Button
                  variant={channelType === "forum" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setChannelType("forum")}
                >
                  <LayoutList className="h-3.5 w-3.5 mr-1" /> Forum
                </Button>
                <Button
                  variant={channelType === "whiteboard" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setChannelType("whiteboard")}
                >
                  <PenTool className="h-3.5 w-3.5 mr-1" /> Whiteboard
                </Button>
                <Button
                  variant={channelType === "showcase" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setChannelType("showcase")}
                >
                  <Sparkles className="h-3.5 w-3.5 mr-1" /> Showcase
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
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={editSystemChannel}
                onChange={(e) => setEditSystemChannel(e.target.checked)}
                className="rounded border-input"
              />
              <span className="text-sm">System messages channel (join/leave/kick/ban)</span>
            </label>
            {state.customRoles.length > 0 && (
              <>
                <div>
                  <Label className="text-xs text-muted-foreground">Restrict visibility to roles</Label>
                  <p className="text-[10px] text-muted-foreground/70 mb-1">If none selected, everyone can see this channel.</p>
                  <div className="space-y-1 max-h-28 overflow-y-auto">
                    {state.customRoles.map((r) => (
                      <label key={r.role_id} className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={editViewRoles.includes(r.role_id)}
                          onChange={(e) => {
                            if (e.target.checked) setEditViewRoles((prev) => [...prev, r.role_id]);
                            else setEditViewRoles((prev) => prev.filter((id) => id !== r.role_id));
                          }}
                          className="rounded border-input"
                        />
                        <span className="text-sm" style={{ color: r.color || undefined }}>{r.name}</span>
                      </label>
                    ))}
                  </div>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Restrict sending to roles</Label>
                  <p className="text-[10px] text-muted-foreground/70 mb-1">If none selected, normal send rules apply.</p>
                  <div className="space-y-1 max-h-28 overflow-y-auto">
                    {state.customRoles.map((r) => (
                      <label key={r.role_id} className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={editWriteRoles.includes(r.role_id)}
                          onChange={(e) => {
                            if (e.target.checked) setEditWriteRoles((prev) => [...prev, r.role_id]);
                            else setEditWriteRoles((prev) => prev.filter((id) => id !== r.role_id));
                          }}
                          className="rounded border-input"
                        />
                        <span className="text-sm" style={{ color: r.color || undefined }}>{r.name}</span>
                      </label>
                    ))}
                  </div>
                </div>
                {editChannelType === "showcase" && (
                  <div>
                    <Label className="text-xs text-muted-foreground">Approved roles for featured pane</Label>
                    <p className="text-[10px] text-muted-foreground/70 mb-1">Roles that can post in the left (featured) pane. If none selected, only owners/moderators can post.</p>
                    <div className="space-y-1 max-h-28 overflow-y-auto">
                      {state.customRoles.map((r) => (
                        <label key={r.role_id} className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={editShowcaseWriteRoles.includes(r.role_id)}
                            onChange={(e) => {
                              if (e.target.checked) setEditShowcaseWriteRoles((prev) => [...prev, r.role_id]);
                              else setEditShowcaseWriteRoles((prev) => prev.filter((id) => id !== r.role_id));
                            }}
                            className="rounded border-input"
                          />
                          <span className="text-sm" style={{ color: r.color || undefined }}>{r.name}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
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

      <RoleManagementDialog open={rolesOpen} onOpenChange={setRolesOpen} />

      {/* Resize handle */}
      {!panelCollapsed && (
        <div
          onMouseDown={onResizeStart}
          className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-primary/30 active:bg-primary/50 transition-colors"
        />
      )}
    </div>
  );
}

function ChannelItem({
  channel,
  isSelected,
  canManage,
  hasUnread,
  unreadCount,
  mentionCount,
  onSelect,
  onEdit,
  onDelete,
  icon,
  showGrip,
  badge,
}: {
  channel: { channel_id: string; name: string; topic?: string };
  isSelected: boolean;
  canManage: boolean;
  hasUnread?: boolean;
  unreadCount?: number;
  mentionCount?: number;
  onSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
  icon: React.ReactNode;
  showGrip?: boolean;
  badge?: React.ReactNode;
}) {
  const unreadHighlight = !isSelected && hasUnread;
  return (
    <div
      className={`group flex items-center gap-1 px-2 py-1 mx-1 rounded cursor-pointer transition-colors ${
        isSelected
          ? "bg-accent text-accent-foreground"
          : unreadHighlight
            ? "text-white font-bold hover:bg-accent/50"
            : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
      }`}
      onClick={onSelect}
      title={channel.topic || channel.name}
    >
      {showGrip && (
        <GripVertical className="h-3 w-3 shrink-0 opacity-0 group-hover:opacity-50 cursor-grab" />
      )}
      {unreadHighlight && (unreadCount ?? 0) > 0 && (
        <span className="text-xs font-bold text-white shrink-0">[{unreadCount! > 99 ? "99+" : unreadCount}]</span>
      )}
      {icon}
      <span className="truncate text-sm">{channel.name}</span>
      {badge}
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
