import { forumFiles, forumImages, forumVideos, type ForumPost, type ForumTag } from "@/lib/api";
import { MessageSquare, Trash2, Play, Paperclip, Link } from "lucide-react";
import { ForumMarkdown } from "@/components/ForumMarkdown";
import { AuthImage } from "@/components/AuthImage";
import { ForumReactions } from "@/components/ForumReactions";
import { ForumTagList } from "@/components/ForumTags";
import { displayUserId } from "@/lib/utils";
import { clickable } from "@/lib/a11y";
import { forumLinkFor } from "@/lib/forumLinks";
import { toast } from "sonner";

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
  /** The channel's tags, to draw the ones this post wears. */
  tags?: ForumTag[];
}

export function ForumPostCard({ post, onClick, onDelete, canDelete, tags }: ForumPostCardProps) {
  const authorDisplay = displayUserId(post.author);
  const images = forumImages(post);
  const videos = forumVideos(post);
  const files = forumFiles(post);
  // The row shows one thing: a picture if there is one, otherwise a clip's
  // poster, which the server writes beside every upload.
  const thumbnail = images[0] ?? (videos[0] ? `${videos[0]}.thumb.jpg` : null);
  const extras = images.length + videos.length - 1;

  return (
    <div
      className="group relative flex gap-3 rounded-lg border p-3 transition-colors hover:bg-accent/50 cursor-pointer"
      {...clickable(onClick, `Open post: ${post.title}`)}
    >
      {/* Thumbnail — the lead image, with a count when the post holds more,
          so the row says there is a set to open without showing all of it. */}
      {thumbnail && (
        <div className="relative shrink-0">
          <AuthImage
            src={thumbnail}
            alt=""
            className="w-24 h-24 object-cover rounded-md bg-muted"
          />
          {images.length === 0 && videos.length > 0 && (
            <span className="absolute inset-0 flex items-center justify-center">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-black/60">
                <Play className="w-3.5 h-3.5 text-white ml-0.5" />
              </span>
            </span>
          )}
          {extras > 0 && (
            <span className="absolute bottom-1 right-1 rounded bg-black/65 px-1.5 py-0.5 text-3xs font-medium tabular-nums text-white">
              +{extras}
            </span>
          )}
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
              className="can-hover:opacity-0 can-hover:group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity shrink-0 cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
          {/* Copy the post's share link. Pasted back into chat it draws a card
              named by this title, resolved per viewer — so a link to a private
              forum reaches the room but its contents reach only those allowed to
              read it. */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              try {
                navigator.clipboard.writeText(forumLinkFor(post.post_id));
                toast.success("Post link copied");
              } catch {
                toast.error("Could not copy — clipboard needs HTTPS");
              }
            }}
            aria-label="Copy post link"
            title="Copy post link"
            className="can-hover:opacity-0 can-hover:group-hover:opacity-100 text-muted-foreground hover:text-foreground transition-opacity shrink-0 cursor-pointer"
          >
            <Link className="w-3.5 h-3.5" />
          </button>
        </div>

        <ForumTagList tagIds={post.tags} tags={tags} size="xs" />

        <p className="text-xs text-muted-foreground">
          {authorDisplay} · {formatTime(post.created_at)}
          {post.edited && " · (edited)"}
        </p>

        {post.body && (
          <div className="ui-hint line-clamp-2">
            <ForumMarkdown content={post.body} />
          </div>
        )}

        <div className="flex items-center gap-2 mt-auto pt-1">
          <ForumReactions targetId={post.post_id} initial={post.reactions} compact />

          {/* Downloads have no thumbnail to stand for them, so the row says
              they are there. */}
          {files.length > 0 && (
            <span
              className="flex items-center gap-1 text-3xs text-muted-foreground ml-auto"
              title={files.length === 1 ? "1 file" : `${files.length} files`}
            >
              <Paperclip className="w-3 h-3" />
              {files.length}
            </span>
          )}
          {/* Comment count */}
          <span className={`flex items-center gap-1 text-3xs text-muted-foreground ${files.length > 0 ? "" : "ml-auto"}`}>
            <MessageSquare className="w-3 h-3" />
            {post.comment_count}
          </span>
        </div>
      </div>
    </div>
  );
}
