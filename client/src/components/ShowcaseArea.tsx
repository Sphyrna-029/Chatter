import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useAppContext } from "@/lib/store";
import { apiSendMessage, apiUploadFile, apiUpdateChannel, type MatrixMessage } from "@/lib/api";
import { PendingAttachments } from "./PendingAttachments";
import { usePendingFiles, MAX_ATTACHMENTS } from "@/hooks/usePendingFiles";
import { STANDARD_SHORTCODES } from "@/lib/emojiShortcodes";
import { MessageItem } from "./MessageItem";
import { EmojiPicker, renderInlineEmojis } from "./EmojiPicker";
import { GifPicker } from "./GifPicker";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Lock, Smile, Image as ImageIcon, Settings, X, UserPlus } from "lucide-react";
import { displayUserId } from "@/lib/utils";
import { toast } from "sonner";

const MAX_MESSAGE_LENGTH = 4000;

async function stripExifData(file: File): Promise<File> {
  return new Promise((resolve) => {
    const img = document.createElement("img");
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) { URL.revokeObjectURL(objectUrl); return resolve(file); }
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(objectUrl);
      canvas.toBlob((blob) => {
        if (!blob) return resolve(file);
        resolve(new File([blob], file.name, { type: blob.type }));
      }, file.type, 1.0);
    };
    img.onerror = () => { URL.revokeObjectURL(objectUrl); resolve(file); };
    img.src = objectUrl;
  });
}

interface ShowcaseChatPaneProps {
  title: string;
  subtitle: string;
  pane: "featured" | "community";
  messages: MatrixMessage[];
  canPost: boolean;
  showReactions: boolean;
  roomId: string;
  channelId: string;
  uploadLimitBytes: number;
  headerExtra?: React.ReactNode;
}

function ShowcaseChatPane({
  title,
  subtitle,
  pane,
  messages,
  canPost,
  showReactions,
  roomId,
  channelId,
  uploadLimitBytes,
  headerExtra,
}: ShowcaseChatPaneProps) {
  const { state } = useAppContext();
  const [input, setInput] = useState("");
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [gifOpen, setGifOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadProcessing, setUploadProcessing] = useState(false);
  const [uploadFileName, setUploadFileName] = useState("");
  const inputRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollWrapperRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  const mergedShortcodes = useMemo(() => {
    const roomInfo = state.currentRoomId ? state.roomInfoMap[state.currentRoomId] : null;
    const custom: Record<string, string> = {};
    if (roomInfo?.custom_emojis) {
      roomInfo.custom_emojis.forEach((url) => {
        const name = url.split("/").pop()?.split(".")[0] || url;
        custom[name] = url;
      });
    }
    if (roomInfo?.emoji_aliases) {
      Object.entries(roomInfo.emoji_aliases).forEach(([alias, url]) => {
        custom[alias] = url;
      });
    }
    return { ...STANDARD_SHORTCODES, ...custom };
  }, [state.currentRoomId, state.roomInfoMap]);

  const getViewport = useCallback((): HTMLElement | null => {
    const wrapper = scrollWrapperRef.current;
    if (!wrapper) return null;
    return wrapper.querySelector("[data-radix-scroll-area-viewport]") as HTMLElement | null;
  }, []);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (isNearBottomRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  // Scroll to bottom on channel load
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView();
  }, [channelId]);

  const handleScroll = useCallback(() => {
    const viewport = getViewport();
    if (!viewport) return;
    const distFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    isNearBottomRef.current = distFromBottom < 100;
    setShowScrollToBottom(!isNearBottomRef.current);
  }, [getViewport]);

  const getDivContent = () => {
    const div = inputRef.current;
    if (!div) return "";
    let text = "";
    const walk = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.textContent || "";
      } else if (node.nodeName === "BR") {
        text += "\n";
      } else if (node.nodeName === "IMG") {
        const img = node as HTMLImageElement;
        text += img.alt || "";
      } else {
        let isBlock = false;
        if (node.nodeType === Node.ELEMENT_NODE) {
          const el = node as HTMLElement;
          const display = window.getComputedStyle(el).display;
          isBlock = display === "block" || display === "flex" || node.nodeName === "DIV";
          if (isBlock && text.length > 0 && !text.endsWith("\n")) text += "\n";
        }
        node.childNodes.forEach(walk);
        if (isBlock && !text.endsWith("\n")) text += "\n";
      }
    };
    div.childNodes.forEach(walk);
    return text.replace(/\n$/, "");
  };

  const {
    files: pendingFiles,
    add: addStagedFile,
    remove: removePendingFile,
    clear: clearPendingFiles,
  } = usePendingFiles();

  const uploadFile = async (file: File): Promise<string | null> => {
    if (uploadLimitBytes > 0 && file.size > uploadLimitBytes) {
      toast.error(`File too large (max ${Math.round(uploadLimitBytes / 1024 / 1024)} MB)`);
      return null;
    }
    setUploading(true);
    setUploadProgress(0);
    setUploadProcessing(false);
    setUploadFileName(file.name);
    try {
      const { url } = await apiUploadFile(file, (pct) => {
        setUploadProgress(pct);
        if (pct >= 100) setUploadProcessing(true);
      });
      return url;
    } catch (err: any) {
      toast.error(err.message || "Upload failed");
      return null;
    } finally {
      setUploading(false);
      setUploadProcessing(false);
    }
  };

  const resolveShortcodes = (raw: string) =>
    raw.replace(/:([a-zA-Z0-9_]+):/g, (match: string, name: string) => {
      const value = mergedShortcodes[name];
      if (!value) return match;
      if (value.startsWith("/") || value.startsWith("http")) return `:emoji{${value}}:`;
      return value;
    });

  const handleSend = async () => {
    const body = getDivContent().trim();
    const toUpload = pendingFiles.map((pf) => pf.file);
    if (!body && toUpload.length === 0) return;
    if (body.length > MAX_MESSAGE_LENGTH) return;
    if (inputRef.current) inputRef.current.innerHTML = "";
    setInput("");
    clearPendingFiles();

    const uploadedUrls: string[] = [];
    for (const file of toUpload) {
      const url = await uploadFile(file);
      if (url) uploadedUrls.push(url);
    }

    // Text and attachments go out as one message, matching the main composer.
    const parts = [body ? resolveShortcodes(body) : "", ...uploadedUrls].filter(Boolean);
    if (parts.length === 0) return;
    try {
      await apiSendMessage(roomId, parts.join("\n"), undefined, undefined, channelId, pane);
    } catch (err: any) {
      toast.error(err.message || "Failed to send message");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const insertTextAtCursor = (text: string) => {
    const div = inputRef.current;
    if (!div) return;
    div.focus();
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) {
      div.appendChild(document.createTextNode(text));
    } else {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(document.createTextNode(text));
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    div.dispatchEvent(new Event("input", { bubbles: true }));
    const inputEvent = new InputEvent("input", { bubbles: true });
    div.dispatchEvent(inputEvent);
    setInput(getDivContent());
  };

  const handleEmojiSelect = (emoji: string) => {
    insertTextAtCursor(emoji);
    setEmojiOpen(false);
  };

  const handleGifSelect = async (url: string) => {
    setGifOpen(false);
    try {
      await apiSendMessage(roomId, url, undefined, undefined, channelId, pane);
    } catch (err: any) {
      toast.error(err.message || "Failed to send GIF");
    }
  };

  /** Stage files on the composer; the upload happens on Send. */
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    let staged = pendingFiles.length;
    for (const file of files) {
      if (uploadLimitBytes > 0 && file.size > uploadLimitBytes) {
        toast.error(`File "${file.name}" too large (max ${Math.round(uploadLimitBytes / 1024 / 1024)} MB)`);
        continue;
      }
      if (staged >= MAX_ATTACHMENTS) {
        toast.error(`You can attach at most ${MAX_ATTACHMENTS} files per message`);
        break;
      }
      // Strip EXIF while staging so the preview matches what will be sent.
      const processed = file.type.startsWith("image/") ? await stripExifData(file) : file;
      addStagedFile(processed);
      staged++;
    }
  };

  const fileInputId = `showcase-file-${pane}`;

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      {/* Pane header */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b shrink-0">
        {pane === "featured" && <Lock className="h-3.5 w-3.5 text-amber-400 shrink-0" />}
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">{title}</h3>
          <p className="text-2xs text-muted-foreground truncate">{subtitle}</p>
        </div>
        {headerExtra}
      </div>

      {/* Messages */}
      <div ref={scrollWrapperRef} className="flex-1 overflow-hidden relative" onScroll={handleScroll}>
        <ScrollArea className="h-full py-2 px-2" onScroll={handleScroll}>
          {messages.length === 0 && (
            <div className="flex items-center justify-center h-32">
              <p className="text-xs text-muted-foreground">No messages yet</p>
            </div>
          )}
          {messages.map((msg, i) => {
            const prev = messages[i - 1];
            const grouped =
              !!prev &&
              prev.content.msgtype !== "m.system" &&
              msg.content.msgtype !== "m.system" &&
              prev.sender === msg.sender &&
              msg.origin_server_ts - prev.origin_server_ts < 60000;
            const msgDate = new Date(msg.origin_server_ts);
            const prevDate = prev ? new Date(prev.origin_server_ts) : null;
            const showDateDivider =
              !prevDate ||
              msgDate.getFullYear() !== prevDate.getFullYear() ||
              msgDate.getMonth() !== prevDate.getMonth() ||
              msgDate.getDate() !== prevDate.getDate();
            const dateLabel = msgDate.toLocaleDateString(undefined, {
              weekday: "long",
              month: "long",
              day: "numeric",
              year: msgDate.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined,
            });
            return (
              <div key={msg.event_id}>
                {showDateDivider && (
                  <div className="flex items-center justify-center gap-2 py-1.5 px-2">
                    <div className="h-px flex-1 bg-border" />
                    <span className="text-xs font-medium px-2 py-0.5 rounded-full whitespace-nowrap text-muted-foreground/70 bg-muted/40">
                      {dateLabel}
                    </span>
                    <div className="h-px flex-1 bg-border" />
                  </div>
                )}
                <MessageItem
                  message={msg}
                  grouped={grouped}
                  disableReactions={!showReactions}
                />
              </div>
            );
          })}
          <div ref={messagesEndRef} />
        </ScrollArea>

        {showScrollToBottom && (
          <button
            onClick={() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })}
            className="absolute bottom-4 right-4 h-8 w-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center shadow-md hover:bg-primary/90 transition-colors z-10"
            title="Scroll to bottom"
          >
            ↓
          </button>
        )}
      </div>

      {/* Upload progress */}
      {uploading && (
        <div className="px-3 py-1.5 border-t bg-muted/30 shrink-0">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="truncate">{uploadProcessing ? `Processing ${uploadFileName}…` : `Uploading ${uploadFileName}… ${uploadProgress}%`}</span>
          </div>
          <div className="mt-1 h-1 w-full rounded-full bg-border overflow-hidden">
            <div className="h-full bg-primary transition-all" style={{ width: `${uploadProgress}%` }} />
          </div>
        </div>
      )}

      {/* Input area */}
      {canPost ? (
        <div className="border-t p-2 shrink-0">
          <PendingAttachments files={pendingFiles} onRemove={removePendingFile} />
          <div className="flex gap-1.5 items-end">
            {/* File upload */}
            <input
              id={fileInputId}
              type="file"
              ref={fileInputRef}
              className="hidden"
              multiple
              onChange={handleFileSelect}
            />
            <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" disabled={uploading} asChild>
              <label htmlFor={uploading ? undefined : fileInputId} className={uploading ? "cursor-not-allowed" : "cursor-pointer"} title="Attach file">
                <ImageIcon className="h-4 w-4" />
              </label>
            </Button>

            {/* Emoji picker */}
            <Popover open={emojiOpen} onOpenChange={setEmojiOpen}>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" title="Emoji">
                  <Smile className="h-4 w-4" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start" side="top">
                <EmojiPicker onSelect={handleEmojiSelect} />
              </PopoverContent>
            </Popover>

            {/* GIF picker */}
            <Popover open={gifOpen} onOpenChange={setGifOpen}>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" title="GIF">
                  <span className="text-3xs font-bold leading-none">GIF</span>
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start" side="top">
                <GifPicker onSelect={handleGifSelect} />
              </PopoverContent>
            </Popover>

            {/* Text input */}
            <div className="relative flex-1">
              {!input && (
                <span className="absolute top-2 left-3 text-sm text-muted-foreground pointer-events-none select-none z-10">
                  Message {pane === "featured" ? "#featured" : "#community"}…
                </span>
              )}
              <div
                ref={inputRef}
                contentEditable
                suppressContentEditableWarning
                onInput={() => setInput(getDivContent())}
                onKeyDown={handleKeyDown}
                className="min-h-[36px] max-h-40 overflow-y-auto w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
              />
            </div>

            <Button
              size="sm"
              className="h-8 shrink-0"
              onClick={handleSend}
              disabled={uploading || (!input.trim() && pendingFiles.length === 0)}
            >
              Send
            </Button>
          </div>
        </div>
      ) : (
        <div className="border-t p-3 flex items-center justify-center gap-1.5 text-sm text-muted-foreground shrink-0">
          <Lock className="h-3.5 w-3.5" />
          <span>You don't have permission to post in this pane</span>
        </div>
      )}
    </div>
  );
}

export function ShowcaseArea() {
  const { state } = useAppContext();
  const [splitPct, setSplitPct] = useState(50);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const onDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      setSplitPct(Math.min(80, Math.max(20, pct)));
    };

    const onMouseUp = () => {
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, []);

  const currentChannel = state.currentChannelId
    ? state.channels.find((c) => c.channel_id === state.currentChannelId)
    : null;

  const myMember = state.roomMembers.find((m) => m.userId === state.userId);
  const myRole = myMember?.role || "member";
  const isPrivileged = myRole === "owner" || myRole === "moderator";
  const myCustomRoles = state.memberCustomRoles[state.userId || ""] ?? [];
  const showcaseWriteRoles = currentChannel?.showcase_write_roles ?? [];
  const showcasePosters = currentChannel?.showcase_posters ?? [];
  const canPostFeatured =
    isPrivileged ||
    (showcaseWriteRoles.length > 0 && showcaseWriteRoles.some((r) => myCustomRoles.includes(r))) ||
    (state.userId != null && showcasePosters.includes(state.userId));

  const featuredMessages = useMemo(
    () => state.messages.filter((m) => m.content.showcase_pane === "featured"),
    [state.messages]
  );
  const communityMessages = useMemo(
    () => state.messages.filter((m) => m.content.showcase_pane === "community"),
    [state.messages]
  );

  const [postersOpen, setPostersOpen] = useState(false);
  const [posterSearch, setPosterSearch] = useState("");

  const handleAddPoster = async (userId: string) => {
    if (!state.currentRoomId || !state.currentChannelId) return;
    const next = [...showcasePosters, userId];
    await apiUpdateChannel(state.currentRoomId, state.currentChannelId, { showcase_posters: next });
  };

  const handleRemovePoster = async (userId: string) => {
    if (!state.currentRoomId || !state.currentChannelId) return;
    const next = showcasePosters.filter((id) => id !== userId);
    await apiUpdateChannel(state.currentRoomId, state.currentChannelId, { showcase_posters: next });
  };

  const eligibleToAdd = state.roomMembers.filter(
    (m) => !showcasePosters.includes(m.userId) && m.userId !== state.userId
  );
  const filteredEligible = posterSearch.trim()
    ? eligibleToAdd.filter((m) => {
        const name = (state.userPresence[m.userId]?.displayName || displayUserId(m.userId)).toLowerCase();
        return name.includes(posterSearch.toLowerCase());
      })
    : eligibleToAdd;

  if (!state.currentRoomId || !state.currentChannelId) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-muted-foreground">Select a channel</p>
      </div>
    );
  }

  const channelName = currentChannel?.name || "showcase";

  return (
    <div ref={containerRef} className="flex flex-1 min-h-0 overflow-hidden">
      <div style={{ width: `${splitPct}%` }} className="flex flex-col min-h-0 overflow-hidden">
        <ShowcaseChatPane
          title="Featured"
          subtitle="Only approved users can post here"
          pane="featured"
          messages={featuredMessages}
          canPost={canPostFeatured}
          showReactions={true}
          roomId={state.currentRoomId}
          channelId={state.currentChannelId}
          uploadLimitBytes={state.uploadLimitBytes}
          headerExtra={isPrivileged ? (
            <Popover open={postersOpen} onOpenChange={setPostersOpen}>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" title="Manage approved posters">
                  <Settings className="h-3.5 w-3.5" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-72 p-3" align="end">
                <p className="text-xs font-semibold mb-2">Approved Posters</p>
                {showcasePosters.length === 0 ? (
                  <p className="text-xs text-muted-foreground mb-2">No approved posters yet. Owners and moderators can always post.</p>
                ) : (
                  <div className="flex flex-col gap-1 mb-2">
                    {showcasePosters.map((uid) => (
                      <div key={uid} className="flex items-center justify-between gap-2 px-2 py-1 rounded bg-muted/40">
                        <span className="text-xs truncate">
                          {state.userPresence[uid]?.displayName || displayUserId(uid)}
                        </span>
                        <button
                          onClick={() => handleRemovePoster(uid)}
                          className="shrink-0 text-muted-foreground hover:text-destructive transition-colors"
                          title="Remove"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <p className="text-xs font-semibold mb-1.5">Add member</p>
                <Input
                  className="h-7 text-xs mb-1.5"
                  placeholder="Search members…"
                  value={posterSearch}
                  onChange={(e) => setPosterSearch(e.target.value)}
                />
                <div className="flex flex-col gap-0.5 max-h-36 overflow-y-auto">
                  {filteredEligible.length === 0 ? (
                    <p className="text-xs text-muted-foreground px-1">No members to add</p>
                  ) : filteredEligible.map((m) => (
                    <button
                      key={m.userId}
                      onClick={() => handleAddPoster(m.userId)}
                      className="flex items-center gap-2 px-2 py-1 rounded hover:bg-muted/60 text-left text-xs transition-colors"
                    >
                      <UserPlus className="h-3 w-3 shrink-0 text-muted-foreground" />
                      <span className="truncate">{state.userPresence[m.userId]?.displayName || displayUserId(m.userId)}</span>
                    </button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          ) : undefined}
        />
      </div>
      {/* Draggable divider */}
      <div
        className="w-1 shrink-0 cursor-col-resize bg-border hover:bg-primary/50 active:bg-primary/70 transition-colors"
        onMouseDown={onDividerMouseDown}
      />
      <div style={{ width: `${100 - splitPct}%` }} className="flex flex-col min-h-0 overflow-hidden">
        <ShowcaseChatPane
          title="Community"
          subtitle={`Everyone in #${channelName} can post here`}
          pane="community"
          messages={communityMessages}
          canPost={true}
          showReactions={false}
          roomId={state.currentRoomId}
          channelId={state.currentChannelId}
          uploadLimitBytes={state.uploadLimitBytes}
        />
      </div>
    </div>
  );
}
