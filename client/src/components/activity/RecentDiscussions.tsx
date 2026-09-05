import { useEffect, useState } from "react";
import { useAppContext } from "@/lib/store";
import {
  apiListForumPosts,
  apiGetRoomThreads,
  type ForumPost,
  type MatrixMessage,
} from "@/lib/api";
import { AuthImage } from "@/components/AuthImage";
import { MessagesSquare, MessageSquareText } from "lucide-react";

interface RecentDiscussionsProps {
  refreshKey: number;
  onSelectRoom: (roomId: string) => void;
}

interface Discussion {
  key: string;
  roomId: string;
  kind: "forum" | "thread";
  title: string;
  replies: number;
  ts: number;
}

const MAX_SHOWN = 6;

function relativeTime(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Forum posts and threads are invisible from the room list, so the newest of
 *  them are surfaced here. */
export function RecentDiscussions({ refreshKey, onSelectRoom }: RecentDiscussionsProps) {
  const { state } = useAppContext();
  const [items, setItems] = useState<Discussion[]>([]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const forumRooms = state.joinedRoomIds.filter(
        (id) => state.roomInfoMap[id]?.room_type === "forum",
      );

      const [postPages, threadPages] = await Promise.all([
        Promise.all(
          forumRooms.map((roomId) =>
            apiListForumPosts(roomId, 5, undefined, "recent")
              .then((r) => r.posts.map((p) => ({ roomId, post: p })))
              .catch(() => [] as { roomId: string; post: ForumPost }[]),
          ),
        ),
        Promise.all(
          state.joinedRoomIds.map((roomId) =>
            apiGetRoomThreads(roomId, undefined, undefined, false, 0, 5)
              .then((r) => r.items.map((t) => ({ roomId, thread: t })))
              .catch(() => [] as { roomId: string; thread: MatrixMessage }[]),
          ),
        ),
      ]);

      const discussions: Discussion[] = [
        ...postPages.flat().map(({ roomId, post }) => ({
          key: `forum:${post.post_id}`,
          roomId,
          kind: "forum" as const,
          title: post.title,
          replies: post.comment_count,
          ts: post.last_activity || post.created_at,
        })),
        ...threadPages.flat().map(({ roomId, thread }) => ({
          key: `thread:${thread.event_id}`,
          roomId,
          kind: "thread" as const,
          title: thread.thread_name || thread.content.body || "Thread",
          replies: thread.thread_reply_count ?? 0,
          ts: thread.origin_server_ts,
        })),
      ]
        .sort((a, b) => b.ts - a.ts)
        .slice(0, MAX_SHOWN);

      if (!cancelled) setItems(discussions);
    }

    load().catch(() => { /* keep what is already listed */ });
    return () => { cancelled = true; };
  }, [refreshKey, state.joinedRoomIds, state.roomInfoMap]);

  if (items.length === 0) return null;

  return (
    <section className="space-y-3">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-muted-foreground uppercase tracking-wide">
        <MessagesSquare className="h-4 w-4" />
        Recent Discussions
      </h2>
      <div className="rounded-lg border border-border divide-y divide-border">
        {items.map((item) => {
          const info = state.roomInfoMap[item.roomId];
          const name = info?.name || "Unnamed";
          return (
            <button
              key={item.key}
              onClick={() => onSelectRoom(item.roomId)}
              className="flex items-center gap-3 w-full px-4 py-2.5 text-left transition-colors hover:bg-accent/50 cursor-pointer"
            >
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent text-3xs font-bold shrink-0">
                {info?.icon_url ? (
                  <AuthImage src={info.icon_url} alt="" className="h-6 w-6 rounded-md object-cover" />
                ) : (
                  name.charAt(0).toUpperCase()
                )}
              </span>
              <div className="min-w-0 flex-1">
                <span className="block text-sm font-medium truncate">{item.title}</span>
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground truncate">
                  {item.kind === "forum" ? (
                    <MessagesSquare className="h-3 w-3 shrink-0" />
                  ) : (
                    <MessageSquareText className="h-3 w-3 shrink-0" />
                  )}
                  <span className="truncate">
                    {name} · {item.replies} {item.kind === "forum" ? "comment" : "repl"}
                    {item.kind === "forum"
                      ? item.replies !== 1 ? "s" : ""
                      : item.replies !== 1 ? "ies" : "y"}
                  </span>
                </span>
              </div>
              <span className="text-xs text-muted-foreground shrink-0">
                {relativeTime(item.ts)}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
