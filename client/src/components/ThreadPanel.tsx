import { useState, useRef, useEffect, useCallback } from "react";
import { ArrowLeft, Pencil, Check, X } from "lucide-react";
import { useAppContext } from "@/lib/store";
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
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
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
    <div className="flex flex-col border-border bg-background flex-1 min-h-0 min-w-0">
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
        <div className="flex items-center gap-2 rounded-md border border-input bg-background px-3 py-2">
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
            disabled={!body.trim()}
            onClick={handleSend}
          >
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}
