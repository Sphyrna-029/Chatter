import { useCallback, useEffect, useState } from "react";
import { Search, X, Image, Film, Music, FileText, MessageSquare, AtSign, Pin, PinOff } from "lucide-react";
import { useAppContext } from "@/lib/store";
import { apiSearchMessages, type MatrixMessage } from "@/lib/api";
import { Loader2 } from "lucide-react";
import { MessageItem } from "./MessageItem";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { displayUserId } from "@/lib/utils";
import { canManageMessages } from "@/lib/permissions";
import { useIsMobile } from "@/hooks/use-mobile";
import { toast } from "sonner";

export type PanelMode = "search" | "mentions" | "pins";

interface MessagePanelProps {
  mode: PanelMode;
  onClose: () => void;
  /** Bring the message into the timeline and highlight it. The panel stays open. */
  onJump: (msg: MatrixMessage) => void;
}

const TITLES: Record<PanelMode, string> = {
  search: "Search",
  mentions: "Mentions",
  pins: "Pinned messages",
};

function formatThreadTime(ts: number) {
  const date = new Date(ts);
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** Consecutive messages from the same person collapse into one block. */
function isGrouped(msg: MatrixMessage, prev: MatrixMessage | undefined) {
  return (
    !!prev &&
    prev.content.msgtype !== "m.system" &&
    msg.content.msgtype !== "m.system" &&
    prev.sender === msg.sender &&
    msg.origin_server_ts - prev.origin_server_ts < 60000
  );
}

/** Footer control for a paged list: a load-more button, or nothing when the
 *  list is complete. */
function LoadMore({
  hasMore,
  loading,
  onLoadMore,
}: {
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
}) {
  if (!hasMore) return null;
  return (
    <div className="flex justify-center px-2 py-3">
      <Button variant="outline" size="sm" className="h-7 text-xs" disabled={loading} onClick={onLoadMore}>
        {loading ? (
          <>
            <Loader2 className="h-3 w-3 animate-spin" />
            Loading...
          </>
        ) : (
          "Load more"
        )}
      </Button>
    </div>
  );
}

/**
 * The right-hand companion panel for search, mentions, and pins. It sits beside
 * the timeline rather than replacing it, so a pinned message or search hit can
 * be read while the conversation stays on screen.
 */
export function MessagePanel({ mode, onClose, onJump }: MessagePanelProps) {
  const {
    state,
    dispatch,
    loadPins,
    loadMorePins,
    loadMoreSearchResults,
    unpinMessage,
    openThread,
  } = useAppContext();
  const isMobile = useIsMobile();
  const { search } = state;

  // The panel is remounted per mode/room (see the key in ChatArea), so the
  // initial values are correct without a synchronous setState in the effect.
  const [mentions, setMentions] = useState<MatrixMessage[]>([]);
  const [mentionsLoading, setMentionsLoading] = useState(mode === "mentions");
  const [mentionsHasMore, setMentionsHasMore] = useState(false);
  const [mentionsOffset, setMentionsOffset] = useState(0);
  const [mentionsLoadingMore, setMentionsLoadingMore] = useState(false);

  const roomId = state.currentRoomId;
  const canUnpin = canManageMessages(state);

  // Mentions are fetched by the panel itself; search results arrive through the
  // store (the provider debounces the query) and pins are already in state.
  useEffect(() => {
    if (mode !== "mentions" || !roomId || !state.userId) return;
    let cancelled = false;
    const username = state.userId.replace(/^@/, "").replace(/:.*$/, "");
    apiSearchMessages(roomId, username, "mention")
      .then((page) => {
        if (cancelled) return;
        setMentions(page.items);
        setMentionsHasMore(page.hasMore);
        setMentionsOffset(page.nextOffset);
      })
      .catch(() => {
        if (!cancelled) setMentions([]);
      })
      .finally(() => {
        if (!cancelled) setMentionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, roomId, state.userId]);

  const loadMoreMentions = useCallback(async () => {
    if (!roomId || !state.userId || !mentionsHasMore || mentionsLoadingMore) return;
    setMentionsLoadingMore(true);
    const username = state.userId.replace(/^@/, "").replace(/:.*$/, "");
    try {
      const page = await apiSearchMessages(
        roomId,
        username,
        "mention",
        "all",
        undefined,
        undefined,
        mentionsOffset,
      );
      // Dedupe in case a new mention arrived and shifted the window.
      setMentions((prev) => {
        const seen = new Set(prev.map((m) => m.event_id));
        return [...prev, ...page.items.filter((m) => !seen.has(m.event_id))];
      });
      setMentionsHasMore(page.hasMore);
      setMentionsOffset(page.nextOffset);
    } catch {
      // Leave the list as-is; the button stays available for a retry.
    } finally {
      setMentionsLoadingMore(false);
    }
  }, [roomId, state.userId, mentionsHasMore, mentionsLoadingMore, mentionsOffset]);

  // Catch up on anything pinned or unpinned while this client was disconnected.
  useEffect(() => {
    if (mode === "pins") void loadPins();
  }, [mode, roomId, state.currentChannelId, loadPins]);

  // A panel you open from a header button should close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const Icon = mode === "search" ? Search : mode === "mentions" ? AtSign : Pin;

  return (
    <aside
      className={
        isMobile
          ? "absolute inset-0 z-30 flex flex-col bg-background"
          : "flex w-[22rem] shrink-0 flex-col border-l bg-background min-h-0"
      }
      aria-label={TITLES[mode]}
    >
      <div className="flex items-center justify-between border-b px-3 py-2 shrink-0">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          <Icon className="h-3.5 w-3.5 text-muted-foreground" />
          {TITLES[mode]}
          {mode === "pins" && state.pinnedMessages.length > 0 && (
            <span className="text-xs text-muted-foreground">({state.pinnedMessages.length})</span>
          )}
        </span>
        <button
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground cursor-pointer"
          title="Close panel"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {mode === "search" && (
        <div className="flex flex-col gap-2 border-b px-3 py-2 shrink-0">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <input
              type="text"
              placeholder={
                search.filter === "user"
                  ? "Search by username..."
                  : search.filter === "file"
                  ? "Search by filename..."
                  : search.filter === "thread"
                  ? "Search threads..."
                  : "Search messages..."
              }
              value={search.query}
              onChange={(e) => dispatch({ type: "SET_SEARCH", payload: { query: e.target.value } })}
              className="w-full rounded-md border border-input bg-transparent pl-8 pr-3 py-1.5 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              autoFocus
            />
          </div>
          <div className="flex flex-wrap gap-1">
            {(["all", "user", "file", "thread"] as const).map((f) => (
              <Button
                key={f}
                variant={search.filter === f ? "default" : "outline"}
                size="sm"
                className="h-6 text-xs px-2"
                onClick={() => {
                  dispatch({ type: "SET_SEARCH", payload: { filter: f } });
                  if (f !== "file") dispatch({ type: "SET_SEARCH", payload: { fileTypeFilter: "all" } });
                }}
              >
                {f === "all" ? "All" : f === "user" ? "Users" : f === "file" ? "Files" : "Threads"}
              </Button>
            ))}
            <Button
              variant={search.thisChannel ? "default" : "outline"}
              size="sm"
              className="h-6 text-xs px-2 ml-auto"
              title={search.thisChannel ? "Only search this channel" : "Search all channels in the room"}
              onClick={() => dispatch({ type: "SET_SEARCH", payload: { thisChannel: !search.thisChannel } })}
            >
              This channel
            </Button>
          </div>
          {search.filter === "file" && (
            <div className="flex flex-wrap gap-1">
              {([
                { key: "all", label: "All types", icon: null },
                { key: "image", label: "Images", icon: Image },
                { key: "video", label: "Videos", icon: Film },
                { key: "audio", label: "Audio", icon: Music },
                { key: "document", label: "Docs", icon: FileText },
              ] as const).map(({ key, label, icon: FilterIcon }) => (
                <Button
                  key={key}
                  variant={search.fileTypeFilter === key ? "default" : "outline"}
                  size="sm"
                  className="h-6 text-xs px-2 gap-1"
                  onClick={() => dispatch({ type: "SET_SEARCH", payload: { fileTypeFilter: key } })}
                >
                  {FilterIcon && <FilterIcon className="h-3 w-3" />}
                  {label}
                </Button>
              ))}
            </div>
          )}
        </div>
      )}

      <ScrollArea className="flex-1 min-h-0 px-1 py-2">
        {mode === "search" && (
          <>
            {search.loading && (
              <p className="text-center text-xs text-muted-foreground py-4">Searching...</p>
            )}
            {!search.loading && search.results.length === 0 && (
              <p className="text-center text-xs text-muted-foreground py-4">
                {search.filter === "thread"
                  ? search.query.trim()
                    ? "No threads found"
                    : "No threads in this room yet"
                  : search.filter === "file"
                  ? "No files found"
                  : search.query.trim()
                  ? "No results found"
                  : "Type to search messages"}
              </p>
            )}
            {search.filter === "thread"
              ? search.results.map((thread) => {
                  const senderName =
                    state.userPresence[thread.sender]?.displayName || displayUserId(thread.sender);
                  const replyCount = thread.thread_reply_count ?? 0;
                  return (
                    <div
                      key={thread.event_id}
                      className="flex items-start gap-2 px-2 py-2 cursor-pointer hover:bg-accent/30 rounded-md transition-colors"
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.currentTarget.click(); } }}
                      onClick={() => {
                        onClose();
                        openThread(thread.event_id);
                      }}
                    >
                      <MessageSquare className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">
                          {thread.thread_name || thread.content.body}
                        </p>
                        {thread.thread_name && (
                          <p className="text-xs text-muted-foreground truncate">{thread.content.body}</p>
                        )}
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {replyCount} {replyCount === 1 ? "reply" : "replies"} · by {senderName} ·{" "}
                          {formatThreadTime(thread.origin_server_ts)}
                        </p>
                      </div>
                    </div>
                  );
                })
              : search.results.map((msg, i) => (
                  <div
                    key={msg.event_id}
                    className="cursor-pointer hover:bg-accent/30 rounded-md transition-colors"
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.currentTarget.click(); } }}
                    onClick={() => onJump(msg)}
                  >
                    <MessageItem message={msg} grouped={isGrouped(msg, search.results[i - 1])} disableReactions />
                  </div>
                ))}
            <LoadMore
              hasMore={search.hasMore}
              loading={search.loadingMore}
              onLoadMore={loadMoreSearchResults}
            />
          </>
        )}

        {mode === "mentions" && (
          <>
            {mentionsLoading && (
              <p className="text-center text-xs text-muted-foreground py-4">Loading mentions...</p>
            )}
            {!mentionsLoading && mentions.length === 0 && (
              <p className="text-center text-xs text-muted-foreground py-4">
                No mentions found in this room
              </p>
            )}
            {mentions.map((msg, i) => (
              <div
                key={msg.event_id}
                className="cursor-pointer hover:bg-accent/30 rounded-md transition-colors"
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.currentTarget.click(); } }}
                onClick={() => onJump(msg)}
              >
                <MessageItem message={msg} grouped={isGrouped(msg, mentions[i - 1])} disableReactions />
              </div>
            ))}
            <LoadMore
              hasMore={mentionsHasMore}
              loading={mentionsLoadingMore}
              onLoadMore={loadMoreMentions}
            />
          </>
        )}

        {mode === "pins" && (
          <>
            {state.pinnedMessages.length === 0 && (
              <p className="text-center text-xs text-muted-foreground py-4">
                No pinned messages in this channel yet
              </p>
            )}
            {state.pinnedMessages.map((msg) => (
              <div key={msg.event_id} className="mb-1">
                <div
                  className="cursor-pointer hover:bg-accent/30 rounded-md transition-colors"
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.currentTarget.click(); } }}
                  onClick={() => onJump(msg)}
                >
                  <MessageItem message={msg} disableReactions hidePinControls />
                </div>
                <div className="flex items-center gap-2 px-2 pb-1">
                  <span className="text-3xs text-muted-foreground">
                    Pinned by{" "}
                    {state.userPresence[msg.pinned_by]?.displayName || displayUserId(msg.pinned_by)}
                  </span>
                  {canUnpin && (
                    <button
                      className="text-3xs text-muted-foreground hover:text-destructive inline-flex items-center gap-1 cursor-pointer"
                      onClick={async () => {
                        try {
                          await unpinMessage(msg.event_id);
                        } catch (e) {
                          toast.error(e instanceof Error ? e.message : "Failed to unpin message");
                        }
                      }}
                    >
                      <PinOff className="h-2.5 w-2.5" />
                      Unpin
                    </button>
                  )}
                </div>
              </div>
            ))}
            <LoadMore
              hasMore={state.pinsHasMore}
              loading={state.loadingMorePins}
              onLoadMore={loadMorePins}
            />
          </>
        )}
      </ScrollArea>
    </aside>
  );
}
