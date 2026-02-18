import { memo, useMemo, useState, useEffect } from "react";
import { useAppContext } from "@/lib/store";
import type { MatrixMessage } from "@/lib/api";
import { apiGetLinkPreview, type LinkPreview } from "@/lib/api";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import hljs from "highlight.js";

const quickReactions = ["👍", "❤️", "😂", "😮", "😢", "🎉"];

const urlRegex = /(https?:\/\/[^\s]+)/g;
const imageExtensions = /\.(jpg|jpeg|png|gif|webp|bmp|svg)(\?.*)?$/i;
const videoExtensions = /\.(mp4|webm|ogg|mov)(\?.*)?$/i;
const audioExtensions = /\.(mp3|wav|flac|aac|m4a)(\?.*)?$/i;

function escapeHtml(text: string) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

/** Returns HTML with URLs as links and @mentions styled, but NO embedded media tags */
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

  // Convert URLs to links — suppress image/video/YouTube URLs since MediaPreview renders those
  escaped = escaped.replace(urlRegex, (url) => {
    if (imageExtensions.test(url) || videoExtensions.test(url) || getYouTubeVideoId(url)) {
      return "";
    }
    const displayUrl = url.length > 60 ? url.slice(0, 57) + "..." : url;
    return `<a href="${url}" target="_blank" class="text-primary hover:underline break-all">${displayUrl}</a>`;
  });

  return escaped;
}

type MessageSegment =
  | { type: "text"; content: string }
  | { type: "code"; content: string; language?: string };

function parseMessageSegments(body: string): MessageSegment[] {
  const codeBlockRegex = /```(?:(\w+)\n|\n?)([\s\S]*?)```/g;
  const segments: MessageSegment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRegex.exec(body)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: "text", content: body.slice(lastIndex, match.index) });
    }
    segments.push({
      type: "code",
      content: match[2],
      language: match[1] || undefined,
    });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < body.length) {
    segments.push({ type: "text", content: body.slice(lastIndex) });
  }

  return segments;
}

function CodeBlock({ code, language }: { code: string; language?: string }) {
  const [copied, setCopied] = useState(false);

  const highlighted = useMemo(() => {
    if (language && hljs.getLanguage(language)) {
      return hljs.highlight(code, { language }).value;
    }
    return hljs.highlightAuto(code).value;
  }, [code, language]);

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative group/code my-1">
      <button
        onClick={handleCopy}
        className="absolute right-2 top-2 opacity-0 group-hover/code:opacity-100 transition-opacity text-xs px-2 py-1 rounded bg-secondary hover:bg-accent text-muted-foreground cursor-pointer"
      >
        {copied ? "Copied!" : "Copy"}
      </button>
      <pre className="rounded-md bg-[#0d1117] p-3 overflow-x-auto text-sm">
        <code
          className="hljs"
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
      </pre>
    </div>
  );
}

const youtubeRegex = /(?:youtube\.com\/(?:watch\?.*v=|shorts\/)|youtu\.be\/)([\w-]{11})/;

function getYouTubeVideoId(url: string): string | null {
  const match = url.match(youtubeRegex);
  return match ? match[1] : null;
}

/** Extract media URLs from body for rendering as React elements */
function extractMediaUrls(body: string): { images: string[]; videos: string[]; audios: string[]; links: string[]; youtubeIds: string[] } {
  const images: string[] = [];
  const videos: string[] = [];
  const audios: string[] = [];
  const links: string[] = [];
  const youtubeIds: string[] = [];
  const matches = body.match(urlRegex);
  if (matches) {
    for (const url of matches) {
      const ytId = getYouTubeVideoId(url);
      if (ytId) youtubeIds.push(ytId);
      else if (imageExtensions.test(url)) images.push(url);
      else if (audioExtensions.test(url)) audios.push(url);
      else if (videoExtensions.test(url)) videos.push(url);
      else links.push(url);
    }
  }
  return { images, videos, audios, links, youtubeIds };
}

/** Link preview card — fetches OG metadata on mount */
function LinkPreviewCard({ url }: { url: string }) {
  const [preview, setPreview] = useState<LinkPreview | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiGetLinkPreview(url)
      .then((data) => { if (!cancelled) setPreview(data); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [url]);

  if (failed || !preview || (!preview.title && !preview.description)) return null;

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-2 flex overflow-hidden rounded-md border border-border bg-secondary/30 hover:bg-secondary/50 transition-colors max-w-md"
    >
      {preview.image && (
        <img
          src={preview.image}
          alt=""
          className="w-24 h-24 object-cover flex-shrink-0"
          onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
        />
      )}
      <div className="flex flex-col justify-center px-3 py-2 min-w-0">
        {preview.site_name && (
          <span className="text-xs text-muted-foreground truncate">{preview.site_name}</span>
        )}
        {preview.title && (
          <span className="text-sm font-medium truncate">{preview.title}</span>
        )}
        {preview.description && (
          <span className="text-xs text-muted-foreground line-clamp-2">{preview.description}</span>
        )}
      </div>
    </a>
  );
}

/** Memoized media preview — React preserves these DOM nodes across parent re-renders */
const MediaPreview = memo(function MediaPreview({ body }: { body: string }) {
  const { images, videos, audios, links, youtubeIds } = useMemo(() => extractMediaUrls(body), [body]);
  if (images.length === 0 && videos.length === 0 && audios.length === 0 && links.length === 0 && youtubeIds.length === 0) return null;
  return (
    <div className="mt-2 space-y-2">
      {youtubeIds.map((id) => (
        <div key={id} className="relative w-full max-w-lg aspect-video rounded-md overflow-hidden">
          <iframe
            src={`https://www.youtube.com/embed/${id}`}
            title="YouTube video"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            className="absolute inset-0 w-full h-full"
          />
        </div>
      ))}
      {images.map((url) => (
        <img
          key={url}
          src={url}
          alt="Image"
          loading="lazy"
          className="max-w-full max-h-80 rounded-md"
          onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
        />
      ))}
      {videos.map((url) => (
        <video
          key={url}
          src={url}
          controls
          preload="metadata"
          className="max-w-full max-h-80 rounded-md"
        />
      ))}
      {audios.map((url) => (
        <audio
          key={url}
          src={url}
          controls
          preload="metadata"
          className="max-w-full"
        />
      ))}
      {links.length > 0 && <LinkPreviewCard url={links[0]} />}
    </div>
  );
});

interface MessageItemProps {
  message: MatrixMessage;
  grouped?: boolean;
}

export function MessageItem({ message, grouped }: MessageItemProps) {
  const { state, dispatch, deleteMessage, editMessage, addReaction } = useAppContext();
  const [isEditing, setIsEditing] = useState(false);
  const [editDraft, setEditDraft] = useState("");
  const isSystem = message.content.msgtype === "m.system";
  const sender = message.sender.split(":")[0].substring(1);
  const initial = sender.substring(0, 1).toUpperCase();
  const time = new Date(message.origin_server_ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  const avatarUrl = state.userPresence[message.sender]?.avatarUrl;
  const isDeleted = message.redacted || message.content.body === "[deleted]";
  const isOwn = message.sender === state.userId;

  if (isSystem) {
    const isLeave = message.content.body.includes("has left");
    return (
      <div className="flex items-center justify-center gap-2 py-1.5 px-2">
        <div className="h-px flex-1 bg-border" />
        <span className={cn(
          "text-xs font-medium px-2 py-0.5 rounded-full whitespace-nowrap",
          isLeave
            ? "text-red-400/80 bg-red-500/10"
            : "text-green-400/80 bg-green-500/10"
        )}>
          {message.content.body}
        </span>
        <span className="text-xs text-muted-foreground/50">{time}</span>
        <div className="h-px flex-1 bg-border" />
      </div>
    );
  }

  const reactions = state.messageReactions[message.event_id] || {};
  const segments = useMemo(
    () => parseMessageSegments(message.content.body),
    [message.content.body]
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
    <div className={cn("group relative px-2 rounded-md hover:bg-accent/50 transition-colors", grouped ? "py-1 -mt-0.5" : "pt-4 pb-2")} data-event-id={message.event_id}>
      <div className="flex items-start gap-3">
        {grouped ? (
          <span className="w-8 flex-shrink-0" />
        ) : (
          <Avatar className="h-8 w-8 mt-0.5 flex-shrink-0">
            {avatarUrl && <AvatarImage src={avatarUrl} alt={sender} />}
            <AvatarFallback className="text-xs font-semibold bg-secondary">
              {initial}
            </AvatarFallback>
          </Avatar>
        )}

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

          {!grouped && (
            <div className="flex items-baseline gap-2">
              <span className="text-sm font-semibold">{sender}</span>
              <span className="text-xs text-muted-foreground">{time}</span>
            </div>
          )}

          {isEditing ? (
            <div className="mt-1">
              <textarea
                className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-none max-h-40 overflow-y-auto"
                value={editDraft}
                onChange={(e) => setEditDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    const trimmed = editDraft.trim();
                    if (trimmed && trimmed !== message.content.body) {
                      editMessage(message.event_id, trimmed);
                    }
                    setIsEditing(false);
                  }
                  if (e.key === "Escape") {
                    setIsEditing(false);
                  }
                }}
                rows={2}
                style={{ fieldSizing: "content" } as React.CSSProperties}
                autoFocus
              />
              <div className="flex gap-2 mt-1 text-xs text-muted-foreground">
                <span>Enter to save</span>
                <span>Esc to cancel</span>
              </div>
            </div>
          ) : (
            <div
              className={cn(
                cn("text-sm break-words [overflow-wrap:anywhere] [word-break:break-word] whitespace-pre-wrap", !grouped && "mt-0.5"),
                isDeleted && "italic text-muted-foreground opacity-60"
              )}
            >
              {segments.map((segment, i) =>
                segment.type === "code" ? (
                  <CodeBlock key={i} code={segment.content} language={segment.language} />
                ) : (
                  <span
                    key={i}
                    dangerouslySetInnerHTML={{
                      __html: processMessageBody(segment.content, state.userId),
                    }}
                  />
                )
              )}
              {message.edited && (
                <span className="text-xs text-muted-foreground/60 italic ml-1">(edited)</span>
              )}
            </div>
          )}

          {/* Media rendered as stable React elements — not inside innerHTML */}
          {!isDeleted && <MediaPreview body={message.content.body} />}

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
          <div className={cn("absolute right-2 opacity-0 group-hover:opacity-100 transition-opacity flex gap-1", grouped ? "top-0" : "top-1")}>
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
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={() => {
                    setEditDraft(message.content.body);
                    setIsEditing(true);
                  }}
                  title="Edit"
                >
                  <span className="text-xs">✎</span>
                </Button>
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
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
