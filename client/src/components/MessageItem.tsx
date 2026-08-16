import { memo, useMemo, useState, useEffect, useRef, useCallback } from "react";
import { EyeOff, Star, Play, FileText, FileArchive, FileCode, FileSpreadsheet, File as FileIcon, Copy, Check, Cast } from "lucide-react";
import { useAppContext } from "@/lib/store";
import type { MatrixMessage, Embed, EmbedAction, EmbedSelect } from "@/lib/api";
import { apiGetLinkPreview, type LinkPreview } from "@/lib/api";
import { AuthImage, AuthAvatarImage } from "./AuthImage";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn, displayUserId } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import * as VisuallyHidden from "@radix-ui/react-visually-hidden";
import { EmojiPicker, isCustomEmojiUrl, renderInlineEmojis } from "./EmojiPicker";
import { useFavoriteGifs } from "@/hooks/useFavoriteGifs";
import { useChromecast } from "@/hooks/useChromecast";
import { useIsMobile } from "@/hooks/use-mobile";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { STANDARD_SHORTCODES } from "@/lib/emojiShortcodes";
import { UserProfileDialog } from "./UserProfileDialog";
import hljs from "highlight.js";

// ─── Custom name font registration ──────────────────────────────────────────
import { ensureFontFace } from "@/lib/fontFace";

const urlRegex = /(https?:\/\/[^\s]+)/g;
const imageExtensions = /\.(jpg|jpeg|png|gif|webp|bmp|svg)(\?.*)?$/i;
const videoExtensions = /\.(mp4|webm|ogg|mov|mkv)(\?.*)?$/i;
const audioExtensions = /\.(mp3|wav|flac|aac|m4a)(\?.*)?$/i;

// Reverse map: Unicode emoji → first matching shortcode name
const standardEmojiToName: Record<string, string> = {};
for (const [name, emoji] of Object.entries(STANDARD_SHORTCODES)) {
  if (!standardEmojiToName[emoji]) standardEmojiToName[emoji] = name;
}

function escapeHtml(text: string) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function escapeAttr(value: string) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Returns HTML with URLs as links and @mentions styled, but NO embedded media tags */
function processMessageBody(body: string, currentUserId: string | null, urlToAlias?: Record<string, string>, roleNames?: Map<string, string>) {
  // Extract custom emoji markers before escaping HTML — replace with placeholders
  const emojiUrls: string[] = [];
  let processed = body.replace(/:emoji\{([^}]+)\}:/g, (_match, url) => {
    const idx = emojiUrls.length;
    emojiUrls.push(url);
    return `\x00EMOJI${idx}\x00`;
  });

  let escaped = escapeHtml(processed);

  // Process @mentions (users and roles)
  escaped = escaped.replace(/@(\w+)/g, (match, name) => {
    // Check if it's a role mention
    const roleColor = roleNames?.get(name.toLowerCase());
    if (roleColor !== undefined) {
      // Sanitize role color to prevent CSS injection — only allow valid hex/named colors
      const safeColor = roleColor && /^#?[a-zA-Z0-9]+$/.test(roleColor) ? roleColor : "";
      const colorStyle = safeColor
        ? `background-color:${safeColor}33;color:${safeColor}`
        : "";
      return `<span class="${cn(
        "rounded px-1 py-0.5 font-semibold text-xs",
        !safeColor && "bg-primary/20 text-primary"
      )}"${colorStyle ? ` style="${colorStyle}"` : ""}>${match}</span>`;
    }
    // User mention
    const mentionedUserId = `@${name}:localhost`;
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
    // Also suppress uploaded file URLs since FileAttachmentCard renders those
    if (/\/external\//.test(url)) {
      return "";
    }
    const displayUrl = url.length > 60 ? url.slice(0, 57) + "..." : url;
    return `<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer" class="text-primary hover:underline break-all">${displayUrl}</a>`;
  });

  // Restore custom emoji placeholders as inline images with data attribute for tooltip
  escaped = escaped.replace(/\x00EMOJI(\d+)\x00/g, (_match, idx) => {
    const url = emojiUrls[parseInt(idx)];
    const safeUrl = escapeAttr(url);
    const alias = urlToAlias?.[url];
    const nameAttr = alias ? ` data-emoji-name=":${escapeAttr(alias)}:"` : "";
    return `<img src="${safeUrl}" alt=":emoji{${safeUrl}}:"${nameAttr} class="inline-block h-5 w-5 object-contain align-middle mx-0.5 cursor-default" />`;
  });

  // Wrap standard Unicode emoji characters with data attribute for tooltip
  escaped = escaped.replace(/\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu, (emoji) => {
    const name = standardEmojiToName[emoji];
    if (!name) return emoji;
    return `<span data-emoji-name=":${name}:">${emoji}</span>`;
  });

  // Text formatting: %%%strobe%%%, **bold**, _italic_
  // RGB strobe (must be before bold to avoid conflict with asterisks)
  escaped = escaped.replace(/%%%(.+?)%%%/g, '<span class="strobe-rgb">$1</span>');
  // Bold
  escaped = escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Italic (use word boundary-ish check to avoid matching underscores in URLs/names)
  escaped = escaped.replace(/(?<![a-zA-Z0-9])_(.+?)_(?![a-zA-Z0-9])/g, '<em>$1</em>');

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
function extractMediaUrls(body: string): { images: string[]; videos: string[]; audios: string[]; files: string[]; links: string[]; youtubeIds: string[] } {
  const images: string[] = [];
  const videos: string[] = [];
  const audios: string[] = [];
  const files: string[] = [];
  const links: string[] = [];
  const youtubeIds: string[] = [];
  // Strip custom emoji markers so they're not treated as full-size media
  const stripped = body.replace(/:emoji\{[^}]+\}:/g, "");
  const matches = stripped.match(urlRegex);
  if (matches) {
    for (const url of matches) {
      const ytId = getYouTubeVideoId(url);
      if (ytId) youtubeIds.push(ytId);
      else if (imageExtensions.test(url)) images.push(url);
      else if (audioExtensions.test(url)) audios.push(url);
      else if (videoExtensions.test(url)) videos.push(url);
      else if (/\/external\//.test(url)) files.push(url);
      else links.push(url);
    }
  }
  return { images, videos, audios, files, links, youtubeIds };
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

  if (failed || !preview || (!preview.title && !preview.description && !preview.image)) return null;

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

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** File attachment card for uploaded non-media files */
function FileAttachmentCard({ url }: { url: string }) {
  const { state } = useAppContext();
  // Extract filename from URL: /external/{folder}/{encoded_filename}
  const segments = url.split("/");
  const rawName = decodeURIComponent(segments[segments.length - 1] || "file");
  // Strip query params
  const fileName = rawName.split("?")[0];
  const dotIdx = fileName.lastIndexOf(".");
  const ext = dotIdx > 0 ? fileName.slice(dotIdx + 1).toUpperCase() : "";
  const baseName = dotIdx > 0 ? fileName.slice(0, dotIdx) : fileName;

  const [fileSize, setFileSize] = useState<number | null>(null);

  useEffect(() => {
    // The Authorization header is not needed here because the media_session
    // HttpOnly cookie is sent automatically by the browser.
    fetch(url, { method: "HEAD" })
      .then((res) => {
        const len = res.headers.get("content-length");
        if (len) setFileSize(parseInt(len, 10));
      })
      .catch(() => {});
  }, [url, state.requireAuthForUploads]);

  const IconComponent = /^(zip|rar|7z|tar|gz|bz2)$/i.test(ext) ? FileArchive
    : /^(js|ts|tsx|jsx|py|rs|go|java|c|cpp|h|html|css|json|xml|yml|yaml|sh|sql|rb|php)$/i.test(ext) ? FileCode
    : /^(csv|xls|xlsx)$/i.test(ext) ? FileSpreadsheet
    : /^(txt|md|log|pdf|doc|docx|rtf)$/i.test(ext) ? FileText
    : FileIcon;

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      download={fileName}
      className="mt-1 flex items-center gap-3 rounded-md border border-border bg-secondary/30 hover:bg-secondary/50 transition-colors px-3 py-2.5 max-w-sm group"
    >
      <IconComponent className="h-8 w-8 text-muted-foreground shrink-0 group-hover:text-foreground transition-colors" />
      <div className="flex flex-col min-w-0">
        <span className="text-sm font-medium truncate">{baseName}</span>
        <span className="text-xs text-muted-foreground">
          {ext ? `${ext} file` : "File"}{fileSize !== null ? ` · ${formatFileSize(fileSize)}` : ""}
        </span>
      </div>
    </a>
  );
}

/** Return the URL unchanged — the browser sends the media_session HttpOnly cookie
 *  automatically for /external/* requests, so no query-param token is needed. */
function useAuthSrc(url: string): string {
  return url;
}

/** Lazy video — shows a first-frame thumbnail with a play button; only loads the video when clicked */
function LazyVideo({ url, onExpand, onCast, castState }: { url: string; onExpand: () => void; onCast?: (url: string) => void; castState?: string }) {
  const [activated, setActivated] = useState(false);
  const isLocal = url.includes("/external/");
  const thumbUrl = `${url}.thumb.jpg`;
  const authSrc = useAuthSrc(url);
  const showCast = onCast && castState && castState !== "unavailable";
  const didAutoPlay = useRef(false);

  if (!activated) {
    return (
      <div
        className="relative w-fit max-w-full rounded-md cursor-pointer bg-zinc-900 overflow-hidden group"
        onClick={() => setActivated(true)}
      >
        {isLocal ? (
          <AuthImage
            src={thumbUrl}
            alt=""
            className="max-w-full max-h-80 rounded-md object-contain"
            onError={(e) => {
              const el = e.currentTarget as HTMLImageElement;
              el.style.display = "none";
              el.parentElement!.style.minWidth = "200px";
              el.parentElement!.style.minHeight = "120px";
            }}
          />
        ) : (
          <video
            src={url}
            preload="metadata"
            className="max-w-full max-h-80 rounded-md pointer-events-none"
          />
        )}
        <div className="absolute inset-0 flex items-center justify-center bg-black/30 group-hover:bg-black/40 transition-colors">
          <div className="w-12 h-12 rounded-full bg-black/60 flex items-center justify-center">
            <Play className="w-6 h-6 text-white ml-0.5" />
          </div>
        </div>
        {showCast && (
          <button
            className="absolute top-1.5 right-1.5 p-1.5 rounded-md bg-black/60 hover:bg-black/80 transition-colors z-10"
            onClick={(e) => { e.stopPropagation(); onCast(url); }}
            title={castState === "connected" ? "Casting" : castState === "no_devices" ? "Cast — no devices found" : "Cast to Chromecast"}
          >
            <Cast className={cn("h-4 w-4", castState === "connected" ? "text-blue-400" : castState === "no_devices" ? "text-white/50" : "text-white")} />
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="relative w-fit max-w-full group">
      <video
        ref={(el) => {
          if (el && !didAutoPlay.current) {
            didAutoPlay.current = true;
            // Must start muted for autoplay to work per browser policy,
            // then unmute so user hears audio and can toggle via controls
            el.muted = true;
            el.play().then(() => { el.muted = false; }).catch(() => {});
          }
        }}
        src={authSrc}
        controls
        preload="auto"
        className="max-w-full max-h-80 rounded-md cursor-pointer"
        onClick={(e) => {
          const video = e.currentTarget;
          video.pause();
          onExpand();
        }}
      />
      {showCast && (
        <button
          className="absolute top-1.5 right-1.5 p-1.5 rounded-md bg-black/60 hover:bg-black/80 transition-colors z-10"
          onClick={(e) => { e.stopPropagation(); onCast(url); }}
          title={castState === "connected" ? "Casting" : castState === "no_devices" ? "Cast — no devices found" : "Cast to Chromecast"}
        >
          <Cast className={cn("h-4 w-4", castState === "connected" ? "text-blue-400" : castState === "no_devices" ? "text-white/50" : "text-white")} />
        </button>
      )}
    </div>
  );
}

function YouTubeEmbed({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  const url = `https://www.youtube.com/watch?v=${id}`;

  function handleCopy(e: React.MouseEvent) {
    e.stopPropagation();
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="relative w-full max-w-lg aspect-video rounded-md overflow-hidden group">
      <iframe
        src={`https://www.youtube.com/embed/${id}`}
        title="YouTube video"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowFullScreen
        className="absolute inset-0 w-full h-full"
      />
      <button
        className="absolute top-1.5 right-1.5 p-1 rounded-md bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity z-10"
        onClick={handleCopy}
        title="Copy video URL"
      >
        {copied ? <Check className="h-4 w-4 text-white" /> : <Copy className="h-4 w-4 text-white" />}
      </button>
    </div>
  );
}

/** Discord-style embed card for bot/webhook messages */
function EmbedCard({ embed, eventId }: { embed: Embed; eventId?: string }) {
  const { wsRef, state } = useAppContext();
  const borderColor = embed.color || "#5865F2";

  const sendInteraction = useCallback((componentId: string, componentType: "button" | "select", values?: string[]) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !eventId || !state.currentRoomId) return;
    ws.send(JSON.stringify({
      type: "embed_interaction",
      room_id: state.currentRoomId,
      event_id: eventId,
      component_id: componentId,
      component_type: componentType,
      values: values || [],
    }));
  }, [wsRef, eventId, state.currentRoomId]);

  // Group actions into rows
  const actionRows = useMemo(() => {
    if (!embed.actions?.length) return [];
    const rows: Map<number, EmbedAction[]> = new Map();
    for (const action of embed.actions) {
      const row = action.row ?? 0;
      if (!rows.has(row)) rows.set(row, []);
      rows.get(row)!.push(action);
    }
    return Array.from(rows.entries()).sort((a, b) => a[0] - b[0]).map(([, actions]) => actions);
  }, [embed.actions]);

  // Group selects into rows
  const selectRows = useMemo(() => {
    if (!embed.selects?.length) return [];
    const rows: Map<number, EmbedSelect[]> = new Map();
    for (const sel of embed.selects) {
      const row = sel.row ?? 99;
      if (!rows.has(row)) rows.set(row, []);
      rows.get(row)!.push(sel);
    }
    return Array.from(rows.entries()).sort((a, b) => a[0] - b[0]).map(([, selects]) => selects);
  }, [embed.selects]);

  const actionStyleClasses: Record<string, string> = {
    primary: "bg-indigo-500 hover:bg-indigo-600 text-white",
    secondary: "bg-zinc-600 hover:bg-zinc-500 text-white",
    success: "bg-emerald-600 hover:bg-emerald-700 text-white",
    danger: "bg-red-600 hover:bg-red-700 text-white",
  };

  return (
    <div className="max-w-[520px] rounded overflow-hidden mt-1 flex" style={{ borderLeft: `4px solid ${borderColor}` }}>
      <div className="bg-secondary/50 p-3 flex-1 min-w-0">
        {embed.author && (
          <div className="flex items-center gap-1.5 mb-1">
            {embed.author.icon_url && <img src={embed.author.icon_url} alt="" className="w-5 h-5 rounded-full" />}
            {embed.author.url ? (
              <a href={embed.author.url} target="_blank" rel="noopener noreferrer" className="text-xs font-semibold text-foreground hover:underline">{embed.author.name}</a>
            ) : (
              <span className="text-xs font-semibold text-foreground">{embed.author.name}</span>
            )}
          </div>
        )}
        <div className="flex gap-3">
          <div className="flex-1 min-w-0">
            {embed.title && (
              embed.url ? (
                <a href={embed.url} target="_blank" rel="noopener noreferrer" className="block text-sm font-semibold text-primary hover:underline mb-0.5">{embed.title}</a>
              ) : (
                <div className="text-sm font-semibold text-foreground mb-0.5">{embed.title}</div>
              )
            )}
            {embed.description && (
              <div className="text-sm text-muted-foreground whitespace-pre-wrap break-words">{embed.description}</div>
            )}
            {embed.fields && embed.fields.length > 0 && (
              <div className="grid gap-y-1.5 gap-x-2 mt-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))" }}>
                {embed.fields.map((field, i) => (
                  <div key={i} className={field.inline ? "" : "col-span-full"}>
                    <div className="text-xs font-semibold text-foreground">{field.name}</div>
                    <div className="text-xs text-muted-foreground whitespace-pre-wrap">{field.value}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
          {embed.thumbnail && (
            <img src={embed.thumbnail.url} alt="" className="w-16 h-16 rounded object-cover flex-shrink-0 mt-0.5" />
          )}
        </div>
        {embed.image && (
          <img src={embed.image.url} alt="" className="max-w-full rounded mt-2" />
        )}
        {(embed.footer || embed.timestamp) && (
          <div className="flex items-center gap-1.5 mt-2 text-[11px] text-muted-foreground">
            {embed.footer?.icon_url && <img src={embed.footer.icon_url} alt="" className="w-4 h-4 rounded-full" />}
            {embed.footer?.text && <span>{embed.footer.text}</span>}
            {embed.footer?.text && embed.timestamp && <span>&middot;</span>}
            {embed.timestamp && <span>{new Date(embed.timestamp).toLocaleString()}</span>}
          </div>
        )}

        {/* Action buttons */}
        {actionRows.length > 0 && (
          <div className="flex flex-col gap-1 mt-2">
            {actionRows.map((row, ri) => (
              <div key={ri} className="flex flex-wrap gap-1">
                {row.map((action) => (
                  <button
                    key={action.id}
                    disabled={action.disabled}
                    onClick={() => sendInteraction(action.id, "button")}
                    className={cn(
                      "inline-flex items-center gap-1 rounded px-3 py-1.5 text-sm font-medium transition-colors cursor-pointer",
                      actionStyleClasses[action.style || "secondary"] || actionStyleClasses.secondary,
                      action.disabled && "opacity-50 cursor-not-allowed"
                    )}
                  >
                    {action.emoji && <span>{action.emoji}</span>}
                    {action.label}
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}

        {/* Select menus */}
        {selectRows.length > 0 && (
          <div className="flex flex-col gap-1 mt-2">
            {selectRows.map((row, ri) => (
              <div key={ri} className="flex flex-col gap-1">
                {row.map((sel) => (
                  <select
                    key={sel.id}
                    disabled={sel.disabled}
                    className={cn(
                      "w-full rounded border border-border bg-background px-2 py-1.5 text-sm text-foreground",
                      sel.disabled && "opacity-50 cursor-not-allowed"
                    )}
                    defaultValue=""
                    onChange={(e) => {
                      if (e.target.value) {
                        sendInteraction(sel.id, "select", [e.target.value]);
                        e.target.value = "";
                      }
                    }}
                  >
                    <option value="" disabled>{sel.placeholder || "Select..."}</option>
                    {sel.options.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.emoji ? `${opt.emoji} ${opt.label}` : opt.label}
                      </option>
                    ))}
                  </select>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Memoized media preview — React preserves these DOM nodes across parent re-renders */
const gifUrlPattern = /\.gif(\?.*)?$/i;

const MediaPreview = memo(function MediaPreview({ body, hiddenBySpoiler, onReveal }: { body: string; hiddenBySpoiler?: boolean; onReveal?: () => void }) {
  const { state } = useAppContext();
  const { images, videos, audios, files, links, youtubeIds } = useMemo(() => extractMediaUrls(body), [body]);
  const [lightbox, setLightbox] = useState<{ url: string; type: "image" | "video" } | null>(null);
  const { addFavorite, removeFavorite, isFavorite } = useFavoriteGifs();
  const { castState, castVideo, deviceName } = useChromecast();
  const lightboxDidAutoPlay = useRef(false);

  /** Return the URL unchanged — the media_session HttpOnly cookie is sent automatically. */
  const withAuth = useCallback((url: string) => url, []);

  const hasMedia = images.length > 0 || videos.length > 0 || audios.length > 0 || files.length > 0 || links.length > 0 || youtubeIds.length > 0;
  if (!hasMedia) return null;

  if (hiddenBySpoiler) {
    return (
      <div
        className="mt-2 flex items-center gap-2 px-3 py-2 rounded-md bg-muted/60 cursor-pointer hover:bg-muted/80 transition-colors w-fit"
        onClick={onReveal}
        title="Click to reveal spoiler media"
      >
        <EyeOff className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className="text-sm text-muted-foreground">Spoiler media — click to reveal</span>
      </div>
    );
  }

  return (
    <div className="mt-2 space-y-2">
      {youtubeIds.map((id) => (
        <YouTubeEmbed key={id} id={id} />
      ))}
      {images.map((url) => {
        const isGif = gifUrlPattern.test(url);
        const fav = isGif && isFavorite(url);
        return isGif ? (
          <div key={url} className="relative group w-fit">
            <AuthImage
              src={url}
              alt="Image"
              preview={false}
              className="max-w-full max-h-80 rounded-md cursor-pointer"
              onClick={() => setLightbox({ url, type: "image" })}
            />
            <button
              className="absolute top-1.5 right-1.5 p-1 rounded-md bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity"
              onClick={(e) => {
                e.stopPropagation();
                fav ? removeFavorite(url) : addFavorite(url);
              }}
              title={fav ? "Remove from favorites" : "Add to favorites"}
            >
              <Star
                className={cn(
                  "h-4 w-4",
                  fav ? "fill-yellow-400 text-yellow-400" : "text-white"
                )}
              />
            </button>
          </div>
        ) : (
          <AuthImage
            key={url}
            src={url}
            alt="Image"
            className="max-w-full max-h-80 rounded-md cursor-pointer"
            onClick={() => setLightbox({ url, type: "image" })}
          />
        );
      })}
      {videos.map((url) => (
        <LazyVideo key={url} url={url} onExpand={() => { lightboxDidAutoPlay.current = false; setLightbox({ url, type: "video" }); }} onCast={(u) => castVideo(u)} castState={castState} />
      ))}
      {audios.map((url) => (
        <audio
          key={url}
          src={withAuth(url)}
          controls
          preload="auto"
          className="max-w-full"
        />
      ))}
      {files.map((url) => (
        <FileAttachmentCard key={url} url={url} />
      ))}
      {links.length > 0 && <LinkPreviewCard url={links[0]} />}

      <Dialog open={lightbox !== null} onOpenChange={(open) => { if (!open) setLightbox(null); }}>
        <DialogContent className="max-w-[90vw] max-h-[90vh] p-0 border-none bg-transparent shadow-none flex items-center justify-center [&>button]:text-white [&>button]:bg-black/50 [&>button]:rounded-full [&>button]:p-1">
          <VisuallyHidden.Root><DialogTitle>Media preview</DialogTitle></VisuallyHidden.Root>
          {lightbox?.type === "image" && (
            <AuthImage src={lightbox.url} alt="Image preview" preview={false} className="max-w-[90vw] max-h-[90vh] object-contain rounded-md" />
          )}
          {lightbox?.type === "video" && (
            <div className="relative group">
              <video
                ref={(el) => {
                  if (el && !lightboxDidAutoPlay.current) {
                    lightboxDidAutoPlay.current = true;
                    el.muted = true;
                    el.play().then(() => { el.muted = false; }).catch(() => {});
                  }
                }}
                src={withAuth(lightbox.url)}
                controls
                className="max-w-[90vw] max-h-[90vh] object-contain rounded-md"
              />
              {castState !== "unavailable" && (
                <button
                  className="absolute top-2 right-2 p-2 rounded-md bg-black/60 hover:bg-black/80 transition-colors z-10"
                  onClick={() => castVideo(lightbox.url)}
                  title={castState === "connected" ? `Casting to ${deviceName}` : castState === "no_devices" ? "Cast — no devices found" : "Cast to Chromecast"}
                >
                  <Cast className={cn("h-5 w-5", castState === "connected" ? "text-blue-400" : castState === "no_devices" ? "text-white/50" : "text-white")} />
                </button>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
});

interface MessageItemProps {
  message: MatrixMessage;
  grouped?: boolean;
  inThread?: boolean;
  triggerEdit?: boolean;
  onEditDone?: () => void;
  disableReactions?: boolean;
}

export function MessageItem({ message, grouped, inThread, triggerEdit, onEditDone, disableReactions }: MessageItemProps) {
  const { state, dispatch, deleteMessage, hardDeleteNotification, editMessage, addReaction, openThread } = useAppContext();
  const isMobile = useIsMobile();
  const [isEditing, setIsEditing] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [spoilerRevealed, setSpoilerRevealed] = useState(false);
  const editRef = useRef<HTMLDivElement>(null);

  // Enter edit mode when triggered externally (e.g. ArrowUp from chat input)
  useEffect(() => {
    if (triggerEdit && !isEditing) {
      setIsEditing(true);
    }
  }, [triggerEdit]);

  const [emojiTip, setEmojiTip] = useState<{ name: string; x: number; y: number } | null>(null);
  const [reactionsDetailOpen, setReactionsDetailOpen] = useState(false);

  // Reverse map of custom emoji URL → alias for hover tooltips
  const urlToAlias = useMemo(() => {
    const aliases = state.currentRoomId
      ? (state.roomInfoMap[state.currentRoomId]?.emoji_aliases ?? {})
      : {};
    return Object.fromEntries(Object.entries(aliases).map(([alias, url]) => [url, alias]));
  }, [state.currentRoomId, state.roomInfoMap]);

  // Convert raw body text (with :emoji{url}: markers) to HTML for the contenteditable div
  const bodyToEditHtml = useCallback((body: string): string => {
    const escaped = body
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    return escaped.replace(/:emoji\{([^}]+)\}:/g, (_match, url) => {
      const safeUrl = escapeAttr(url);
      return `<img src="${safeUrl}" data-emoji-url="${safeUrl}" alt=":emoji{${safeUrl}}:" class="inline-block h-5 w-5 object-contain align-middle mx-0.5" />`;
    });
  }, []);

  // Read the contenteditable div back into a text string with :emoji{url}: markers
  const getEditDivContent = useCallback((): string => {
    const div = editRef.current;
    if (!div) return "";
    const walk = (node: Node): string => {
      let result = "";
      node.childNodes.forEach((child) => {
        if (child.nodeType === Node.TEXT_NODE) {
          result += child.textContent ?? "";
        } else if ((child as Element).tagName === "IMG") {
          const url = (child as HTMLImageElement).dataset.emojiUrl ?? "";
          result += `:emoji{${url}}:`;
        } else if ((child as Element).tagName === "BR") {
          result += "\n";
        } else {
          const tag = (child as Element).tagName;
          result += walk(child);
          if (tag === "DIV" || tag === "P") result += "\n";
        }
      });
      return result;
    };
    return walk(div).replace(/\n+$/, "");
  }, []);
  const isSystem = message.content.msgtype === "m.system";
  const isWebhook = message.content.webhook === true;
  const isBot = message.content.bot === true;
  const isExternal = isWebhook || isBot;
  const senderUsername = isWebhook
    ? (message.content.webhook_name || "Webhook")
    : isBot
    ? (message.content.bot_name || "Bot")
    : displayUserId(message.sender);
  const sender = isExternal
    ? senderUsername
    : (state.userPresence[message.sender]?.displayName || senderUsername);
  const initial = sender.substring(0, 1).toUpperCase();
  const time = new Date(message.origin_server_ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  const avatarUrl = isWebhook
    ? (message.content.webhook_avatar_url || undefined)
    : isBot
    ? (message.content.bot_avatar_url || undefined)
    : state.userPresence[message.sender]?.avatarUrl;
  const isDeleted = message.redacted || message.content.body === "[deleted]";
  const isOwn = message.sender === state.userId;
  const myUsername = state.userId ? displayUserId(state.userId) : null;
  const isMentioned = !isDeleted && myUsername != null && message.content.body.includes(`@${myUsername}`);
  const isSpoilerMsg = message.content.spoiler === true && !isDeleted;
  const showSpoilerMask = isSpoilerMsg && !spoilerRevealed;
  // Only show the text spoiler pill if the body has visible text beyond embedded media URLs.
  // If the body is purely an image/video/audio URL, MediaPreview already shows the spoiler overlay.
  const spoilerHasVisibleText = showSpoilerMask && (() => {
    const withoutEmoji = message.content.body.replace(/:emoji\{[^}]+\}:/g, "");
    const withoutMedia = withoutEmoji.replace(/(https?:\/\/[^\s]+)/g, (url) =>
      imageExtensions.test(url) || videoExtensions.test(url) || audioExtensions.test(url) || getYouTubeVideoId(url) !== null
        ? ""
        : url
    );
    return withoutMedia.trim().length > 0;
  })();

  // Populate edit div with HTML and focus with cursor at end
  useEffect(() => {
    if (isEditing && editRef.current) {
      const div = editRef.current;
      div.innerHTML = bodyToEditHtml(message.content.body);
      div.focus();
      const range = document.createRange();
      range.selectNodeContents(div);
      range.collapse(false);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  }, [isEditing]);

  // Role-based permissions
  const roomInfo = state.currentRoomId ? state.roomInfoMap[state.currentRoomId] : null;
  const myMember = state.roomMembers.find(m => m.userId === state.userId);
  const senderMember = state.roomMembers.find(m => m.userId === message.sender);
  const myRole = myMember?.role || "member";
  const senderRole = senderMember?.role || "member";
  const canDeleteOthers =
    (myRole === "owner" && senderRole !== "owner") ||
    (myRole === "moderator" && senderRole === "member");

  // Role color: first custom role with a color wins as fallback
  const senderRoleIds = state.memberCustomRoles[message.sender] || [];
  const senderTopRoleColor = senderRoleIds.reduce<string | undefined>((acc, rid) => {
    if (acc) return acc;
    const r = state.customRoles.find((cr) => cr.role_id === rid);
    return r?.color || acc;
  }, undefined);

  const senderNameColor =
    senderRole === "owner" && roomInfo?.owner_name_color
      ? roomInfo.owner_name_color
      : senderRole === "moderator" && roomInfo?.mod_name_color
        ? roomInfo.mod_name_color
        : senderTopRoleColor;

  // Map of lowercase role name -> color (or "") for role mention rendering
  const roleNamesMap = useMemo(() => {
    const map = new Map<string, string>();
    map.set("owner", roomInfo?.owner_name_color || "");
    map.set("moderator", roomInfo?.mod_name_color || "");
    for (const role of state.customRoles) {
      map.set(role.name.toLowerCase(), role.color || "");
    }
    return map;
  }, [state.customRoles, roomInfo?.owner_name_color, roomInfo?.mod_name_color]);

  const nameFontUrl = !isExternal ? state.userPresence[message.sender]?.nameFontUrl : undefined;
  if (nameFontUrl) {
    ensureFontFace(message.sender, nameFontUrl);
  }

  const canDeleteNotification = myRole === "owner" || myRole === "moderator";

  if (message.content.msgtype === "m.watchparty") {
    return (
      <div className="group flex items-center justify-center gap-2 py-1.5 px-2">
        <div className="h-px flex-1 bg-border" />
        <span className="text-xs font-medium px-2 py-0.5 rounded-full whitespace-nowrap text-blue-400/80 bg-blue-500/10">
          {message.content.body}
        </span>
        <span className="text-xs text-muted-foreground/50">{time}</span>
        {canDeleteNotification && (
          <button
            className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground/50 hover:text-destructive"
            title="Delete notification"
            onClick={() => { if (confirm("Delete this notification?")) hardDeleteNotification(state.currentRoomId!, message.event_id); }}
          >
            <span className="text-xs">✕</span>
          </button>
        )}
        <div className="h-px flex-1 bg-border" />
      </div>
    );
  }

  if (isSystem) {
    const body = message.content.body;
    const isWatchparty = body.includes("the video") || body.includes("skipped to");
    const isLeave = body.includes("has left");
    const systemReactions = state.messageReactions[message.event_id] || {};
    const hasReactions = Object.keys(systemReactions).length > 0;
    return (
      <div className="py-0.5 px-2" data-event-id={message.event_id}>
        <div className="group flex items-center gap-2">
          <div className="h-px flex-1 bg-border" />
          <span className={cn(
            "text-xs font-medium px-2 py-0.5 rounded-full whitespace-nowrap",
            isWatchparty
              ? "text-blue-400/80 bg-blue-500/10"
              : isLeave
                ? "text-red-400/80 bg-red-500/10"
                : "text-green-400/80 bg-green-500/10"
          )}>
            {body}
          </span>
          <span className="text-xs text-muted-foreground/50">{time}</span>
          <Popover>
            <PopoverTrigger asChild>
              <button
                className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground/50 hover:text-foreground text-xs"
                title="Add reaction"
              >
                😊
              </button>
            </PopoverTrigger>
            <PopoverContent side="top" className="w-auto p-0" align="center">
              <EmojiPicker
                onSelect={(emoji) => addReaction(message.event_id, emoji)}
                roomCustomEmojis={state.currentRoomId ? (state.roomInfoMap[state.currentRoomId]?.custom_emojis ?? []) : []}
                emojiAliases={state.currentRoomId ? (state.roomInfoMap[state.currentRoomId]?.emoji_aliases ?? {}) : {}}
              />
            </PopoverContent>
          </Popover>
          {canDeleteNotification && (
            <button
              className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground/50 hover:text-destructive"
              title="Delete notification"
              onClick={() => { if (confirm("Delete this notification?")) hardDeleteNotification(state.currentRoomId!, message.event_id); }}
            >
              <span className="text-xs">✕</span>
            </button>
          )}
          <div className="h-px flex-1 bg-border" />
        </div>
        {hasReactions && (
          <div className="flex flex-wrap gap-1 mt-1 justify-center">
            {Object.entries(systemReactions).map(([emoji, userIds]) =>
              userIds.length > 0 && (
                <Tooltip key={emoji}>
                  <TooltipTrigger asChild>
                    <button
                      className={cn(
                        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-sm transition-colors cursor-pointer hover:bg-accent",
                        userIds.includes(state.userId || "") ? "border-primary/50 bg-primary/10" : "border-border"
                      )}
                      onClick={() => addReaction(message.event_id, emoji)}
                    >
                      {isCustomEmojiUrl(emoji) ? (
                        <img src={emoji} alt="emoji" className="inline-block h-5 w-5 object-contain" />
                      ) : emoji}
                      <span className="text-muted-foreground font-medium">{userIds.length}</span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {(() => {
                      const names = userIds.map((id) => state.userPresence[id]?.displayName || displayUserId(id));
                      const shown = names.slice(0, 5);
                      const remaining = names.length - shown.length;
                      return shown.join(", ") + (remaining > 0 ? ` +${remaining} more` : "");
                    })()}
                  </TooltipContent>
                </Tooltip>
              )
            )}
          </div>
        )}
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
    ? (state.userPresence[message.content.reply_to_sender]?.displayName || displayUserId(message.content.reply_to_sender))
    : null;

  return (
    <div className={cn("group relative px-2 rounded-md transition-colors", isMentioned ? "bg-amber-400/10 hover:bg-amber-400/15" : "hover:bg-accent/50", grouped ? "py-1 -mt-0.5" : isMobile ? "pt-2 pb-1" : "pt-4 pb-2")} data-event-id={message.event_id}>
      <div className={cn("flex items-start", isMobile ? "gap-2" : "gap-3")}>
        {grouped ? (
          <span className={cn("flex-shrink-0", isMobile ? "w-7" : "w-10")} />
        ) : (
          <Avatar className={cn("mt-0.5 flex-shrink-0", isMobile ? "h-7 w-7" : "h-10 w-10", !isExternal && "cursor-pointer")} onClick={() => !isExternal && setProfileOpen(true)}>
            <AuthAvatarImage src={avatarUrl} />
            <AvatarFallback className={cn("font-semibold bg-secondary", isMobile ? "text-[10px]" : "text-xs")}>
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
              <span className="truncate max-w-xs inline-flex items-center gap-0.5">
                {message.content.reply_to_spoiler
                  ? <span className="italic">Spoiler message</span>
                  : renderInlineEmojis(message.content.reply_to_body || "...")}
              </span>
            </button>
          )}

          {!grouped && (
            <div className="flex items-baseline gap-2">
              <span
                className={cn("text-sm font-semibold", !isExternal && "cursor-pointer hover:underline")}
                style={{
                  ...(senderNameColor ? { color: senderNameColor } : {}),
                  ...(nameFontUrl ? { fontFamily: `'user-font-${CSS.escape(message.sender)}'` } : {}),
                }}
                onClick={() => !isExternal && setProfileOpen(true)}
              >
                {sender}
              </span>
              {isExternal && (
                <span className="text-[10px] font-semibold px-1 py-0.5 rounded bg-indigo-500/20 text-indigo-400 leading-none">{isBot ? "BOT" : "HOOK"}</span>
              )}
              <span className="text-xs text-muted-foreground">{time}</span>
            </div>
          )}

          {isEditing ? (
            <div className="mt-1">
              <div
                ref={editRef}
                contentEditable
                role="textbox"
                aria-multiline="true"
                suppressContentEditableWarning
                className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring max-h-40 overflow-y-auto break-words"
                style={{ wordBreak: "break-word", whiteSpace: "pre-wrap", lineHeight: "20px" }}
                onKeyDown={(e) => {
                  if (e.key === "Backspace" && editRef.current) {
                    const sel = window.getSelection();
                    if (sel && sel.isCollapsed && sel.rangeCount > 0) {
                      const range = sel.getRangeAt(0);
                      const container = range.startContainer;
                      const offset = range.startOffset;
                      let imgToRemove: Node | null = null;
                      if (container === editRef.current && offset > 0) {
                        const child = container.childNodes[offset - 1];
                        if (child && (child as Element).tagName === "IMG") imgToRemove = child;
                      } else if (container.nodeType === Node.TEXT_NODE && offset === 0) {
                        const prev = container.previousSibling;
                        if (prev && (prev as Element).tagName === "IMG") imgToRemove = prev;
                      }
                      if (imgToRemove) {
                        e.preventDefault();
                        const nextSibling = imgToRemove.nextSibling;
                        imgToRemove.parentNode?.removeChild(imgToRemove);
                        // Restore cursor position where the image was
                        const newRange = document.createRange();
                        if (nextSibling) {
                          newRange.setStartBefore(nextSibling);
                        } else {
                          newRange.selectNodeContents(editRef.current);
                          newRange.collapse(false);
                        }
                        newRange.collapse(true);
                        sel.removeAllRanges();
                        sel.addRange(newRange);
                        return;
                      }
                    }
                  }
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    const trimmed = getEditDivContent().trim();
                    if (trimmed && trimmed !== message.content.body) {
                      editMessage(message.event_id, trimmed);
                    }
                    setIsEditing(false);
                    onEditDone?.();
                  }
                  if (e.key === "Escape") {
                    setIsEditing(false);
                    onEditDone?.();
                  }
                }}
              />
              <div className="flex gap-2 mt-1 text-xs text-muted-foreground">
                <span>Enter to save</span>
                <span>Esc to cancel</span>
              </div>
            </div>
          ) : spoilerHasVisibleText ? (
            <div
              className={cn("inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md cursor-pointer bg-muted hover:bg-muted/70 transition-colors select-none", !grouped && "mt-0.5")}
              onClick={() => setSpoilerRevealed(true)}
              title="Click to reveal spoiler"
            >
              <EyeOff className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span className="text-xs font-medium text-muted-foreground">Spoiler — click to reveal</span>
            </div>
          ) : (
            <div
              className={cn(
                cn("text-sm break-words [overflow-wrap:anywhere] [word-break:break-word] whitespace-pre-wrap", !grouped && "mt-0.5"),
                isDeleted && "italic text-muted-foreground opacity-60"
              )}
              onMouseOver={(e) => {
                const el = (e.target as HTMLElement).closest("[data-emoji-name]");
                if (el) {
                  const rect = el.getBoundingClientRect();
                  setEmojiTip({ name: el.getAttribute("data-emoji-name")!, x: rect.left + rect.width / 2, y: rect.top });
                } else {
                  setEmojiTip(null);
                }
              }}
              onMouseLeave={() => setEmojiTip(null)}
            >
              {segments.map((segment, i) =>
                segment.type === "code" ? (
                  <CodeBlock key={i} code={segment.content} language={segment.language} />
                ) : (
                  <span
                    key={i}
                    dangerouslySetInnerHTML={{
                      __html: processMessageBody(segment.content, state.userId, urlToAlias, roleNamesMap),
                    }}
                  />
                )
              )}
              {message.edited && (
                <span className="text-xs text-muted-foreground/60 italic ml-1">(edited)</span>
              )}
              {emojiTip && (
                <div
                  className="fixed z-50 px-2 py-1 text-xs rounded bg-popover border border-border text-popover-foreground shadow pointer-events-none -translate-x-1/2"
                  style={{ left: emojiTip.x, top: emojiTip.y - 4, transform: "translate(-50%, -100%)" }}
                >
                  {emojiTip.name}
                </div>
              )}
            </div>
          )}

          {/* Thread reply count indicator */}
          {!inThread && !isDeleted && (message.thread_reply_count ?? 0) > 0 && (
            <button
              className="flex items-center gap-1.5 mt-1 text-xs text-primary hover:underline cursor-pointer"
              onClick={() => openThread(message.event_id)}
            >
              <span>⋮</span>
              <span>{message.thread_reply_count} {message.thread_reply_count === 1 ? "reply" : "replies"}</span>
            </button>
          )}

          {/* Media rendered as stable React elements — not inside innerHTML */}
          {!isDeleted && <MediaPreview body={message.content.body} hiddenBySpoiler={showSpoilerMask} onReveal={() => setSpoilerRevealed(true)} />}

          {/* Rich embeds */}
          {!isDeleted && message.content.embeds?.map((embed, i) => (
            <EmbedCard key={i} embed={embed} eventId={message.event_id} />
          ))}

          {/* Reactions */}
          {!disableReactions && Object.keys(reactions).length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {Object.entries(reactions).map(
                ([emoji, userIds]) =>
  userIds.length > 0 && (
    <Tooltip key={emoji}>
      <TooltipTrigger asChild>
        <button
          key={emoji}
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-sm transition-colors cursor-pointer hover:bg-accent",
            userIds.includes(state.userId || "")
              ? "border-primary/50 bg-primary/10"
              : "border-border"
          )}
          onClick={() =>
            addReaction(message.event_id, emoji)
          }
        >
          <span>
            {isCustomEmojiUrl(emoji) ? (
              <img src={emoji} alt="emoji" className="inline-block h-5 w-5 object-contain" />
            ) : (
              emoji
            )}
          </span>
          <span className="text-muted-foreground font-medium">
            {userIds.length}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent>
        {(() => {
          const names = userIds.map((id) => state.userPresence[id]?.displayName || displayUserId(id));
          const shown = names.slice(0, 5);
          const remaining = names.length - shown.length;
          return shown.join(", ") + (remaining > 0 ? ` +${remaining} more` : "");
        })()}
      </TooltipContent>
    </Tooltip>
  )
              )}
              <button
                className="inline-flex items-center justify-center rounded-full border border-border px-1.5 py-0.5 text-xs text-muted-foreground transition-colors cursor-pointer hover:bg-accent"
                onClick={() => setReactionsDetailOpen(true)}
                title="View all reactions"
              >
                ···
              </button>
            </div>
          )}

          {/* Reactions detail dialog */}
          {reactionsDetailOpen && (
            <Dialog open={reactionsDetailOpen} onOpenChange={setReactionsDetailOpen}>
              <DialogContent className="max-w-sm">
                <DialogTitle className="text-sm font-semibold">Reactions</DialogTitle>
                <div className="space-y-3 max-h-64 overflow-y-auto">
                  {Object.entries(reactions).map(([emoji, userIds]) =>
                    userIds.length > 0 ? (
                      <div key={emoji} className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="text-base">
                            {isCustomEmojiUrl(emoji) ? (
                              <img src={emoji} alt="emoji" className="inline-block h-5 w-5 object-contain" />
                            ) : (
                              emoji
                            )}
                          </span>
                          <span className="text-xs text-muted-foreground font-medium">{userIds.length}</span>
                        </div>
                        <div className="flex flex-wrap gap-1 pl-7">
                          {userIds.map((id) => (
                            <span key={id} className="text-xs text-muted-foreground">
                              {state.userPresence[id]?.displayName || displayUserId(id)}
                            </span>
                          ))}
                        </div>
                      </div>
                    ) : null
                  )}
                </div>
              </DialogContent>
            </Dialog>
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
            {!inThread && !isExternal && message.content.msgtype !== "m.system" && (
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={() => openThread(message.event_id)}
                title="Open thread"
              >
                <span className="text-xs">⋮</span>
              </Button>
            )}
            {!disableReactions && <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="icon" className="h-6 w-6">
                  <span className="text-xs">😊</span>
                </Button>
              </PopoverTrigger>
              <PopoverContent
                side="top"
                className="w-auto p-0"
                align="end"
              >
                <EmojiPicker
                  onSelect={(emoji) => addReaction(message.event_id, emoji)}
                  roomCustomEmojis={
                    state.currentRoomId
                      ? (state.roomInfoMap[state.currentRoomId]?.custom_emojis ?? [])
                      : []
                  }
                  emojiAliases={
                    state.currentRoomId
                      ? (state.roomInfoMap[state.currentRoomId]?.emoji_aliases ?? {})
                      : {}
                  }
                />
              </PopoverContent>
            </Popover>}

            {isOwn && (
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={() => setIsEditing(true)}
                title="Edit"
              >
                <span className="text-xs">✎</span>
              </Button>
            )}
            {(isOwn || canDeleteOthers) && (
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
      {!isExternal && <UserProfileDialog open={profileOpen} onOpenChange={setProfileOpen} userId={message.sender} displayName={sender} />}
    </div>
  );
}
