import { useState, useRef, useEffect, useCallback } from "react";
import { ArrowLeft, Pencil, Check, X, Paperclip } from "lucide-react";
import { useAppContext } from "@/lib/store";
import { apiUploadFile } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { MessageItem } from "./MessageItem";
import { displayUserId } from "@/lib/utils";
import { AuthAvatarImage } from "./AuthImage";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { EmojiPicker } from "./EmojiPicker";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

export function ThreadPanel() {
  const { state, closeThread, sendThreadMessage, setThreadName } = useAppContext();
  const [body, setBody] = useState("");
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const { threadRootMessage, threadMessages, userPresence, currentRoomId, roomInfoMap } = state;

  const roomCustomEmojis = currentRoomId ? (roomInfoMap[currentRoomId]?.custom_emojis ?? []) : [];
  const emojiAliases = currentRoomId ? (roomInfoMap[currentRoomId]?.emoji_aliases ?? {}) : {};

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [threadMessages.length]);

  const handleSend = useCallback(async () => {
    const trimmed = body.trim();
    if (!trimmed) return;
    setBody("");
    try {
      await sendThreadMessage(trimmed);
    } catch {}
  }, [body, sendThreadMessage]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const insertEmoji = useCallback((emoji: string) => {
    setBody((prev) => prev + emoji);
    setEmojiOpen(false);
    inputRef.current?.focus();
  }, []);

  const handleFileUpload = useCallback(async (file: File) => {
    if (state.uploadLimitBytes > 0 && file.size > state.uploadLimitBytes) {
      alert(`File too large (max ${Math.round(state.uploadLimitBytes / 1024 / 1024)} MB)`);
      return;
    }
    setUploading(true);
    setUploadProgress(0);
    try {
      const { url } = await apiUploadFile(file, (pct) => setUploadProgress(pct));
      const msg = body.trim() ? `${body.trim()} ${url}` : url;
      setBody("");
      await sendThreadMessage(msg);
    } catch (err: any) {
      alert(err.message || "Upload failed");
    } finally {
      setUploading(false);
    }
  }, [body, sendThreadMessage, state.uploadLimitBytes]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) handleFileUpload(file);
  }, [handleFileUpload]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.kind === "file") {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) handleFileUpload(file);
        return;
      }
    }
  }, [handleFileUpload]);

  // Drag-and-drop file upload
  const [dragging, setDragging] = useState(false);
  const dragCounter = useRef(0);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (e.dataTransfer.types.includes("Files")) {
      setDragging(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) {
      setDragging(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    dragCounter.current = 0;
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      handleFileUpload(files[0]);
    }
  }, [handleFileUpload]);

  const startEditingName = useCallback(() => {
    setNameDraft(threadRootMessage?.thread_name ?? "");
    setEditingName(true);
    setTimeout(() => nameInputRef.current?.focus(), 0);
  }, [threadRootMessage?.thread_name]);

  const commitName = useCallback(async () => {
    setEditingName(false);
    const trimmed = nameDraft.trim();
    if (trimmed === (threadRootMessage?.thread_name ?? "")) return;
    try {
      await setThreadName(trimmed);
    } catch {}
  }, [nameDraft, setThreadName, threadRootMessage?.thread_name]);

  const cancelEditName = useCallback(() => {
    setEditingName(false);
    setNameDraft("");
  }, []);

  if (!threadRootMessage) return null;

  const rootSender = userPresence[threadRootMessage.sender]?.displayName
    || displayUserId(threadRootMessage.sender);
  const rootAvatarUrl = userPresence[threadRootMessage.sender]?.avatarUrl;
  const rootInitial = rootSender.substring(0, 1).toUpperCase();
  const rootTime = new Date(threadRootMessage.origin_server_ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  const replyCount = threadMessages.length;

  return (
    <div
      className="relative flex flex-col border-border bg-background flex-1 min-h-0 min-w-0"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Drag overlay */}
      {dragging && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 border-2 border-dashed border-primary rounded-md pointer-events-none">
          <div className="flex flex-col items-center gap-2">
            <Paperclip className="h-8 w-8 text-primary" />
            <span className="text-sm font-medium text-primary">Drop file to upload</span>
          </div>
        </div>
      )}
      {/* Header */}
      <div className="group flex items-center gap-2 px-3 py-2.5 border-b border-border shrink-0">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-sm shrink-0"
          onClick={closeThread}
          title="Back to chat"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to chat
        </Button>
        <div className="flex items-center gap-1 flex-1 min-w-0">
          {editingName ? (
            <>
              <input
                ref={nameInputRef}
                className="flex-1 min-w-0 text-sm font-semibold bg-transparent border-b border-primary outline-none"
                value={nameDraft}
                placeholder="Thread name…"
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitName();
                  if (e.key === "Escape") cancelEditName();
                }}
                maxLength={80}
              />
              <button onClick={commitName} title="Save" className="text-primary hover:text-primary/80 shrink-0">
                <Check className="h-3.5 w-3.5" />
              </button>
              <button onClick={cancelEditName} title="Cancel" className="text-muted-foreground hover:text-foreground shrink-0">
                <X className="h-3.5 w-3.5" />
              </button>
            </>
          ) : (
            <>
              <span className="text-sm font-semibold truncate">
                {threadRootMessage.thread_name || "Thread"}
              </span>
              <button
                onClick={startEditingName}
                title="Set thread name"
                className="text-muted-foreground hover:text-foreground transition-colors shrink-0 opacity-0 group-hover:opacity-100"
              >
                <Pencil className="h-3 w-3" />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Thread participants */}
      {threadRootMessage.thread_participants && threadRootMessage.thread_participants.length > 0 && (
        <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border/50 shrink-0">
          <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider shrink-0">
            Members
          </span>
          <div className="flex items-center -space-x-1.5 flex-wrap">
            {threadRootMessage.thread_participants.map((pid) => {
              const pName = userPresence[pid]?.displayName || displayUserId(pid);
              const pAvatar = userPresence[pid]?.avatarUrl;
              return (
                <Avatar key={pid} className="h-5 w-5 border-2 border-background" title={pName}>
                  <AuthAvatarImage src={pAvatar} />
                  <AvatarFallback className="text-[8px] font-semibold bg-secondary">
                    {pName.substring(0, 1).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
              );
            })}
          </div>
          <span className="text-[10px] text-muted-foreground">
            {threadRootMessage.thread_participants.length}
          </span>
        </div>
      )}

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {/* Root message */}
        <div className="px-3 pt-3 pb-2 border-b border-border/50">
          <div className="flex items-start gap-2">
            <Avatar className="h-7 w-7 mt-0.5 shrink-0">
              <AuthAvatarImage src={rootAvatarUrl} />
              <AvatarFallback className="text-xs font-semibold bg-secondary">
                {rootInitial}
              </AvatarFallback>
            </Avatar>
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline gap-1.5">
                <span className="text-sm font-semibold truncate">{rootSender}</span>
                <span className="text-xs text-muted-foreground shrink-0">{rootTime}</span>
              </div>
              <p className="text-sm break-words [overflow-wrap:anywhere] whitespace-pre-wrap mt-0.5">
                {threadRootMessage.content.body}
              </p>
            </div>
          </div>
        </div>

        {/* Reply count divider */}
        {replyCount > 0 && (
          <div className="flex items-center gap-2 px-3 py-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              {replyCount} {replyCount === 1 ? "reply" : "replies"}
            </span>
            <div className="flex-1 h-px bg-border" />
          </div>
        )}

        {/* Thread messages */}
        <div className="pb-2">
          {threadMessages.map((msg, i) => {
            const prevMsg = threadMessages[i - 1];
            const grouped =
              i > 0 &&
              prevMsg.sender === msg.sender &&
              msg.origin_server_ts - prevMsg.origin_server_ts < 5 * 60 * 1000;
            return (
              <MessageItem key={msg.event_id} message={msg} grouped={grouped} inThread />
            );
          })}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input area */}
      <div className="shrink-0 px-3 pb-3 pt-2 border-t border-border">
        {uploading && (
          <div className="flex items-center gap-2 mb-2">
            <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full bg-primary rounded-full transition-all duration-200"
                style={{ width: `${uploadProgress}%` }}
              />
            </div>
            <span className="text-[10px] text-muted-foreground shrink-0">{uploadProgress}%</span>
          </div>
        )}
        <div className="flex items-center gap-2 rounded-md border border-input bg-background px-3 py-2">
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={handleFileSelect}
          />
          <button
            className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer shrink-0"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            title="Upload file"
          >
            <Paperclip className="h-4 w-4" />
          </button>
          <textarea
            ref={inputRef}
            className="flex-1 resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground max-h-24 min-h-[1.25rem] self-center"
            placeholder="Reply in thread…"
            value={body}
            rows={1}
            onChange={(e) => {
              setBody(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = `${Math.min(e.target.scrollHeight, 96)}px`;
            }}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
          />
          <Popover open={emojiOpen} onOpenChange={setEmojiOpen}>
            <PopoverTrigger asChild>
              <button
                className="text-base leading-none hover:scale-110 transition-transform cursor-pointer shrink-0"
                title="Emoji"
              >
                😊
              </button>
            </PopoverTrigger>
            <PopoverContent side="top" align="end" className="w-auto p-0">
              <EmojiPicker
                onSelect={insertEmoji}
                roomCustomEmojis={roomCustomEmojis}
                emojiAliases={emojiAliases}
              />
            </PopoverContent>
          </Popover>
          <Button
            size="sm"
            className="h-7 px-2 shrink-0"
            disabled={(!body.trim() && !uploading) || uploading}
            onClick={handleSend}
          >
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}
