import { useAppContext } from "@/lib/store";
import type { MatrixMessage } from "@/lib/api";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

const quickReactions = ["👍", "❤️", "😂", "😮", "😢", "🎉"];

const urlRegex = /(https?:\/\/[^\s]+)/g;
const imageExtensions = /\.(jpg|jpeg|png|gif|webp|bmp|svg)(\?.*)?$/i;

function escapeHtml(text: string) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function processMessageBody(body: string, currentUserId: string | null) {
  let escaped = escapeHtml(body);

  // Process @mentions
  escaped = escaped.replace(/@(\w+)/g, (match, username) => {
    const mentionedUserId = `@${username}:localhost`;
    const isSelf = mentionedUserId === currentUserId;
    return `<span class="${cn(
      "rounded px-1 py-0.5 font-semibold text-xs",
      isSelf
        ? "bg-blue-500/20 text-blue-400"
        : "bg-primary/20 text-primary"
    )}">${match}</span>`;
  });

  // Convert URLs to links / images
  return escaped.replace(urlRegex, (url) => {
    const displayUrl = url.length > 60 ? url.slice(0, 57) + "..." : url;
    if (imageExtensions.test(url)) {
      return `<a href="${url}" target="_blank" class="text-primary hover:underline break-all">${displayUrl}</a><br><img src="${url}" alt="Image" loading="lazy" class="mt-2 max-w-full max-h-80 rounded-md" onerror="this.style.display='none'">`;
    }
    return `<a href="${url}" target="_blank" class="text-primary hover:underline break-all">${displayUrl}</a>`;
  });
}

interface MessageItemProps {
  message: MatrixMessage;
}

export function MessageItem({ message }: MessageItemProps) {
  const { state, dispatch, deleteMessage, addReaction } = useAppContext();
  const sender = message.sender.split(":")[0].substring(1);
  const initial = sender.substring(0, 1).toUpperCase();
  const time = new Date(message.origin_server_ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  const isDeleted = message.redacted || message.content.body === "[deleted]";
  const isOwn = message.sender === state.userId;

  const reactions = state.messageReactions[message.event_id] || {};
  const processedBody = processMessageBody(
    message.content.body,
    state.userId
  );

  const handleReply = () => {
    dispatch({ type: "SET_REPLYING_TO", payload: message });
  };

  const scrollToParent = () => {
    if (!message.content.in_reply_to) return;
    const el = document.querySelector(`[data-event-id="${message.content.in_reply_to}"]`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("bg-accent");
      setTimeout(() => el.classList.remove("bg-accent"), 1500);
    }
  };

  const replySender = message.content.reply_to_sender
    ? message.content.reply_to_sender.split(":")[0].substring(1)
    : null;

  return (
    <div className="group relative py-1 px-2 rounded-md hover:bg-accent/50 transition-colors" data-event-id={message.event_id}>
      <div className="flex items-start gap-3">
        <Avatar className="h-8 w-8 mt-0.5 flex-shrink-0">
          <AvatarFallback className="text-xs font-semibold bg-secondary">
            {initial}
          </AvatarFallback>
        </Avatar>

        <div className="flex-1 min-w-0 overflow-hidden">
          {/* Reply quote */}
          {message.content.in_reply_to && replySender && (
            <button
              className="flex items-center gap-1.5 mb-1 pl-2 border-l-2 border-primary/50 text-xs text-muted-foreground hover:text-foreground cursor-pointer transition-colors"
              onClick={scrollToParent}
            >
              <span className="font-semibold">{replySender}</span>
              <span className="truncate max-w-xs">{message.content.reply_to_body || "..."}</span>
            </button>
          )}

          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold">{sender}</span>
            <span className="text-xs text-muted-foreground">{time}</span>
          </div>

          <div
            className={cn(
              "text-sm mt-0.5 break-words [overflow-wrap:anywhere]",
              isDeleted && "italic text-muted-foreground opacity-60"
            )}
            dangerouslySetInnerHTML={{ __html: processedBody }}
          />

          {/* Reactions */}
          {Object.keys(reactions).length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {Object.entries(reactions).map(
                ([emoji, userIds]) =>
                  userIds.length > 0 && (
                    <button
                      key={emoji}
                      className={cn(
                        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors cursor-pointer hover:bg-accent",
                        userIds.includes(state.userId || "")
                          ? "border-primary/50 bg-primary/10"
                          : "border-border"
                      )}
                      onClick={() =>
                        addReaction(message.event_id, emoji)
                      }
                    >
                      <span>{emoji}</span>
                      <span className="text-muted-foreground font-medium">
                        {userIds.length}
                      </span>
                    </button>
                  )
              )}
            </div>
          )}
        </div>

        {/* Action buttons (shown on hover) */}
        {!isDeleted && (
          <div className="absolute right-2 top-1 opacity-0 group-hover:opacity-100 transition-opacity flex gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={handleReply}
              title="Reply"
            >
              <span className="text-xs">↩</span>
            </Button>
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="icon" className="h-6 w-6">
                  <span className="text-xs">😊</span>
                </Button>
              </PopoverTrigger>
              <PopoverContent
                side="top"
                className="w-auto p-2"
                align="end"
              >
                <div className="flex gap-1">
                  {quickReactions.map((emoji) => (
                    <button
                      key={emoji}
                      className="p-1.5 rounded hover:bg-accent transition-colors text-lg cursor-pointer"
                      onClick={() =>
                        addReaction(message.event_id, emoji)
                      }
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>

            {isOwn && (
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 text-destructive hover:text-destructive"
                onClick={() => {
                  if (confirm("Delete this message?")) {
                    deleteMessage(message.event_id);
                  }
                }}
              >
                <span className="text-xs">✕</span>
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
