import { useAppContext } from "@/lib/store";
import type { ForumPost } from "@/lib/api";
import { MessageSquare, Trash2 } from "lucide-react";
import { ForumMarkdown } from "@/components/ForumMarkdown";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";

function isCustomEmojiUrl(s: string) {
  return s.startsWith("/") || s.startsWith("http");
}

function formatTime(ts: number) {
  const d = new Date(ts);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return d.toLocaleDateString();
}

interface ForumPostCardProps {
  post: ForumPost;
  onClick: () => void;
  onDelete?: () => void;
  canDelete: boolean;
}

export function ForumPostCard({ post, onClick, onDelete, canDelete }: ForumPostCardProps) {
  const { state, addReaction } = useAppContext();
  const roomId = post.room_id;
  const authorDisplay = post.author.split(":")[0]?.substring(1) || post.author;
  const reactionEntries = Object.entries(post.reactions || {});

  return (
    <div
      className="group relative flex gap-3 rounded-lg border p-3 transition-colors hover:bg-accent/50 cursor-pointer"
      onClick={onClick}
    >
      {/* Thumbnail */}
      {post.image_url && (
        <div className="shrink-0">
          <img
            src={post.image_url}
            alt=""
            className="w-24 h-24 object-cover rounded-md"
          />
        </div>
      )}

      {/* Content */}
      <div className="flex-1 min-w-0 flex flex-col gap-1">
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-semibold text-sm leading-tight line-clamp-1">
            {post.title}
          </h3>
          {canDelete && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete?.();
              }}
              className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity shrink-0 cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          {authorDisplay} · {formatTime(post.created_at)}
          {post.edited && " · (edited)"}
        </p>

        {post.body && (
          <div className="text-xs text-muted-foreground/80 line-clamp-2">
            <ForumMarkdown content={post.body} />
          </div>
        )}

        <div className="flex items-center gap-2 mt-auto pt-1">
          {/* Reactions */}
          {reactionEntries.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {reactionEntries.map(([emoji, userIds]) =>
                userIds.length > 0 ? (
                  <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    key={emoji}
                    onClick={(e) => {
                      e.stopPropagation();
                      addReaction(post.post_id, emoji);
                    }}
                    className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] transition-colors cursor-pointer ${
                      userIds.includes(state.userId ?? "")
                        ? "border-primary/50 bg-primary/10"
                        : "border-border hover:bg-accent"
                    }`}
                  >
                    {isCustomEmojiUrl(emoji) ? (
                      <img src={emoji} alt="emoji" className="inline-block h-3 w-3 object-contain" />
                    ) : (
                      emoji
                    )}
                    <span className="text-muted-foreground font-medium">{userIds.length}</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  {userIds.map(id => (
                    <p key={id}>{id}</p>
                  ))}
                </TooltipContent>
              </Tooltip>
                ) : null
              )}
            </div>
          )}

          {/* Comment count */}
          <span className="flex items-center gap-1 text-[10px] text-muted-foreground ml-auto">
            <MessageSquare className="w-3 h-3" />
            {post.comment_count}
          </span>
        </div>
      </div>
    </div>
  );
}
