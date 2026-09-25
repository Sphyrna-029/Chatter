import { useState, useRef, useEffect, useCallback } from "react";
import { ArrowLeft, Pencil, Check, X, Paperclip, Trash2, Smile, Pin, ChevronDown, ChevronRight, Reply } from "lucide-react";
import { useAppContext } from "@/lib/store";
import { apiSendThreadMessage } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { MessageItem } from "./MessageItem";
import { displayUserId } from "@/lib/utils";
import { AuthAvatarImage } from "./AuthImage";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { EmojiPicker, renderInlineEmojis } from "./EmojiPicker";
import { canManageMessages } from "@/lib/permissions";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { toast } from "sonner";
import { useConfirm } from "@/components/ConfirmDialog";
import { PendingAttachments } from "./PendingAttachments";
import { usePendingFiles, MAX_ATTACHMENTS } from "@/hooks/usePendingFiles";
import { OutgoingUploads } from "./OutgoingUploads";
import { enqueueOutgoing, useOutgoingUploads, type OutgoingTarget } from "@/lib/outgoingUploads";
import { scrollBehavior } from "@/lib/theme/display";

export function ThreadPanel() {
  const confirm = useConfirm();
  const { state, dispatch, closeThread, setThreadName, deleteThread, unpinMessage } = useAppContext();
  const [body, setBody] = useState("");
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [pinsOpen, setPinsOpen] = useState(false);
  const {
    files: pendingFiles,
    add: addStagedFile,
    remove: removePendingFile,
    clear: clearPendingFiles,
  } = usePendingFiles();
  const outgoing = useOutgoingUploads();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const { threadRootMessage, threadMessages, threadReplyingTo, threadPins, userPresence, currentRoomId, roomInfoMap } = state;

  /** What to call this thread when its send is watched from somewhere else. */
  const threadLabel = threadRootMessage?.thread_name
    ? `“${threadRootMessage.thread_name}”`
    : "a thread";
  /** Where this composer posts, so its own batches are not labelled. */
  const here: OutgoingTarget | undefined =
    currentRoomId && state.activeThreadEventId
      ? { kind: "thread", roomId: currentRoomId, threadEventId: state.activeThreadEventId }
      : undefined;

  const roomCustomEmojis = currentRoomId ? (roomInfoMap[currentRoomId]?.custom_emojis ?? []) : [];
  const emojiAliases = currentRoomId ? (roomInfoMap[currentRoomId]?.emoji_aliases ?? {}) : {};

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: scrollBehavior() });
  }, [threadMessages.length]);

  // Starting a reply is aiming the composer, so put the cursor there.
  useEffect(() => {
    if (threadReplyingTo) inputRef.current?.focus();
  }, [threadReplyingTo]);

  const cancelReply = useCallback(() => {
    dispatch({ type: "SET_THREAD_REPLYING_TO", payload: null });
  }, [dispatch]);

  const handleSend = useCallback(async () => {
    const trimmed = body.trim();
    if (!trimmed && pendingFiles.length === 0) return;
    // Read now rather than when the send resolves: a thread can be closed, or
    // another one opened, long before a large attachment has finished going
    // up, and the reply belongs to the thread it was written in.
    const roomId = state.currentRoomId;
    const threadEventId = state.activeThreadEventId;
    if (!roomId || !threadEventId) return;
    const replyTo = state.threadReplyingTo?.event_id;
    setBody("");
    cancelReply();

    // A reply with files is handed to the outgoing queue whole, so closing the
    // thread — or the panel — does not take the upload with it.
    if (pendingFiles.length > 0) {
      const files = pendingFiles.map((staged) => staged.file);
      clearPendingFiles();
      enqueueOutgoing({
        target: { kind: "thread", roomId, threadEventId, replyTo },
        label: threadLabel,
        body: trimmed,
        files,
      });
      return;
    }

    try {
      await apiSendThreadMessage(roomId, threadEventId, trimmed, replyTo);
    } catch {
      // Matching the previous behaviour: a refused reply is reported by the
      // request layer, and the thread stays open.
    }
  }, [body, pendingFiles, clearPendingFiles, state.currentRoomId, state.activeThreadEventId, state.threadReplyingTo, threadLabel, cancelReply]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape" && threadReplyingTo) {
      e.preventDefault();
      cancelReply();
      return;
    }
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


  /** Stage files on the composer; nothing is uploaded or sent until Send. */
  const stageFiles = useCallback((files: File[]) => {
    let staged = pendingFiles.length;
    for (const file of files) {
      if (state.uploadLimitBytes > 0 && file.size > state.uploadLimitBytes) {
        toast.error(`File "${file.name}" too large (max ${Math.round(state.uploadLimitBytes / 1024 / 1024)} MB)`);
        continue;
      }
      if (staged >= MAX_ATTACHMENTS) {
        toast.error(`You can attach at most ${MAX_ATTACHMENTS} files per message`);
        break;
      }
      addStagedFile(file);
      staged++;
    }
  }, [addStagedFile, pendingFiles.length, state.uploadLimitBytes]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const filesList = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (filesList.length > 0) stageFiles(filesList);
  }, [stageFiles]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const item of items) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      stageFiles(files);
    }
  }, [stageFiles]);

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
      stageFiles(files);
    }
  }, [stageFiles]);

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

  const myMember = state.roomMembers.find((m) => m.userId === state.userId);
  const threadOwnerMember = state.roomMembers.find((m) => m.userId === threadRootMessage.sender);
  const myRole = myMember?.role ?? "member";
  const threadOwnerRole = threadOwnerMember?.role ?? "member";
  const isThreadOwner = threadRootMessage.sender === state.userId;
  const canDelete =
    isThreadOwner ||
    (myRole === "owner" && threadOwnerRole !== "owner") ||
    (myRole === "moderator" && threadOwnerRole === "member");

  const handleDeleteThread = async () => {
    if (!(await confirm({ title: "Delete this thread?", description: "All replies will be deleted too.", confirmLabel: "Delete", destructive: true }))) return;
    try {
      await deleteThread();
    } catch {}
  };

  const replyCount = threadMessages.length;
  const mayUnpin = canManageMessages(state);

  /** Bring a pinned reply into view in the thread, the way a reply quote does. */
  const jumpToPin = (eventId: string) => {
    const el = document.querySelector(`[data-thread-panel] [data-event-id="${eventId}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: scrollBehavior(), block: "center" });
    el.classList.add("bg-accent");
    setTimeout(() => el.classList.remove("bg-accent"), 1500);
  };

  const handleUnpin = async (eventId: string) => {
    try {
      await unpinMessage(eventId);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to unpin");
    }
  };

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
        {canDelete && (
          <button
            onClick={handleDeleteThread}
            title="Delete thread"
            className="text-muted-foreground hover:text-destructive transition-colors shrink-0 can-hover:opacity-0 can-hover:group-hover:opacity-100"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
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
                className="text-muted-foreground hover:text-foreground transition-colors shrink-0 can-hover:opacity-0 can-hover:group-hover:opacity-100"
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
          <span className="ui-heading shrink-0">
            Members
          </span>
          <div className="flex items-center -space-x-1.5 flex-wrap">
            {threadRootMessage.thread_participants.map((pid) => {
              const pName = userPresence[pid]?.displayName || displayUserId(pid);
              const pAvatar = userPresence[pid]?.avatarUrl;
              return (
                <Avatar key={pid} className="h-5 w-5 border-2 border-background" title={pName}>
                  <AuthAvatarImage src={pAvatar} />
                  <AvatarFallback className="text-3xs font-semibold bg-secondary">
                    {pName.substring(0, 1).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
              );
            })}
          </div>
          <span className="ui-meta">
            {threadRootMessage.thread_participants.length}
          </span>
        </div>
      )}

      {/* Pinned replies — collapsed by default so a thread with pins still
          opens on the conversation, not on a list about it. */}
      {threadPins.length > 0 && (
        <div className="border-b border-border/50 shrink-0">
          <button
            type="button"
            onClick={() => setPinsOpen((open) => !open)}
            className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left hover:bg-accent/50 transition-colors"
          >
            {pinsOpen ? (
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            )}
            <Pin className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="ui-heading">Pinned</span>
            <span className="ui-meta">{threadPins.length}</span>
          </button>
          {pinsOpen && (
            <div className="max-h-48 overflow-y-auto pb-1">
              {threadPins.map((pin) => {
                const pinSender = userPresence[pin.sender]?.displayName || displayUserId(pin.sender);
                return (
                  <div key={pin.event_id} className="group/pin flex items-start gap-2 px-3 py-1 hover:bg-accent/50">
                    <button
                      type="button"
                      onClick={() => jumpToPin(pin.event_id)}
                      className="min-w-0 flex-1 text-left"
                      title="Jump to message"
                    >
                      <span className="text-xs font-semibold">{pinSender}</span>
                      <p className="text-xs text-muted-foreground truncate">
                        {pin.content.spoiler
                          ? <span className="italic">Spoiler message</span>
                          : renderInlineEmojis(pin.content.body)}
                      </p>
                    </button>
                    {mayUnpin && (
                      <button
                        type="button"
                        onClick={() => handleUnpin(pin.event_id)}
                        title="Unpin message"
                        className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground can-hover:opacity-0 can-hover:group-hover/pin:opacity-100"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto min-h-0" data-thread-panel>
        {/* Root message */}
        <div className="px-3 pt-3 pb-2 border-b border-border/50" data-event-id={threadRootMessage.event_id}>
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
            {/* The root is part of the conversation, so it can be answered
                like any reply. */}
            <button
              type="button"
              onClick={() => dispatch({ type: "SET_THREAD_REPLYING_TO", payload: threadRootMessage })}
              title="Reply"
              className="shrink-0 text-muted-foreground hover:text-foreground"
            >
              <Reply className="h-3.5 w-3.5" />
            </button>
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
        {/* The single bar that stood here said which file it was under; with
            several going up it named them one after another too fast to read.
            Each tile carries its own now. */}
        <OutgoingUploads
          batches={outgoing.filter(
            (batch) =>
              batch.target.kind === "thread" &&
              batch.target.threadEventId === state.activeThreadEventId,
          )}
          here={here}
        />
        {threadReplyingTo && (
          <div className="mb-2 border-l-2 border-l-primary px-3 py-2 bg-accent/30 rounded-sm flex items-center justify-between gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-primary">
                Replying to {userPresence[threadReplyingTo.sender]?.displayName || displayUserId(threadReplyingTo.sender)}
              </p>
              <p className="text-xs text-muted-foreground truncate inline-flex items-center gap-0.5">
                {threadReplyingTo.content.spoiler
                  ? <span className="italic">Spoiler message</span>
                  : renderInlineEmojis(threadReplyingTo.content.body)}
              </p>
            </div>
            <button
              className="text-muted-foreground hover:text-foreground flex-shrink-0 cursor-pointer"
              onClick={cancelReply}
              title="Cancel reply"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}
        <PendingAttachments files={pendingFiles} onRemove={removePendingFile} />
        <div className="flex items-center gap-2 rounded-md border border-input bg-background px-3 py-2">
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            multiple
            onChange={handleFileSelect}
          />
          <button
            className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer shrink-0"
            onClick={() => fileInputRef.current?.click()}
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
                className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer shrink-0"
                title="Emoji"
              >
                <Smile className="h-4 w-4" />
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
            // Nothing to wait for any more: a reply with files is handed to
            // the outgoing queue, so the composer is free straight away.
            disabled={!body.trim() && pendingFiles.length === 0}
            onClick={handleSend}
          >
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}
