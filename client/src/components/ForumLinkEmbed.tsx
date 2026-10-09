import { useEffect, useState } from "react";
import {
  Book,
  Check,
  Copy,
  Link2Off,
  MessageSquare,
  Reply,
} from "lucide-react";
import { toast } from "sonner";
import { cn, displayUserId } from "@/lib/utils";
import {
  forumLinkFor,
  forumReplyLinkFor,
  peekForumPreview,
  resolveForumPreview,
} from "@/lib/forumLinks";
import { requestForumPost } from "@/lib/pendingForumPost";
import type { ForumPreview } from "@/lib/api";
import { AuthAvatarImage } from "@/components/AuthImage";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { renderInlineEmojis } from "./EmojiPicker";

/** Stands in for a forum link this viewer cannot follow.
 *
 *  Says nothing about what is behind it, because nothing is known: the server
 *  answers one 404 for a post that does not exist, one in a room the caller is
 *  not in, one in a forum channel they cannot see, and a reply that does not
 *  belong to the post. So this is not "you are not allowed" — it is the honest
 *  extent of what there is to report, and it reads the same for a post that was
 *  deleted an hour ago.
 *
 *  It exists because the link text is suppressed from the body, and a message
 *  whose whole content was a link would otherwise render as an empty bubble. */
function UnavailableForum() {
  return (
    <div className="mt-1 flex w-full max-w-[min(520px,100%)] items-center gap-2 rounded-md border border-dashed border-border bg-secondary/20 px-2.5 py-2 text-xs text-muted-foreground">
      <Link2Off className="h-3.5 w-3.5 shrink-0" />
      <span>Post unavailable</span>
    </div>
  );
}

/**
 * The card a shared forum post or reply link draws under the message that
 * shared it.
 *
 * It replaces the link in the body rather than sitting beside it: the card says
 * which post it is, who wrote it and what it says, jumps there when clicked, and
 * carries a button to copy the link back out. For a reply the headline is still
 * the post it lives under — that is the forum the reply belongs to — and the
 * body shown is the reply's own.
 *
 * A viewer the server will not resolve the link for gets `UnavailableForum`
 * instead, and that is the point of the feature rather than an error path: a
 * post shared out of a forum channel half the room cannot read reaches the whole
 * room, and its contents reach only the people already allowed to read them.
 *
 * Three states, not two, and the third is why: *still resolving* renders nothing,
 * because a placeholder that appeared and then turned into a card would flicker
 * on every scroll; and a *failure worth retrying* — a dropped connection, a rate
 * limit — also renders nothing, because it is not the server saying no and must
 * not be reported as one.
 */
export function ForumLinkEmbed({
  postId,
  commentId,
}: { postId: string; commentId: string | null }) {
  // Answered during render when this link has been resolved before, so a card
  // that scrolls out of the timeline and back does not flicker.
  const cached = peekForumPreview(postId, commentId);

  // Only an unresolved link needs state, and the key is kept beside the result
  // so a card whose props change ignores the previous answer rather than being
  // reset by the effect.
  const key = commentId ? `${postId}:${commentId}` : postId;
  const [fetched, setFetched] = useState<{
    key: string;
    /** The server's answer, or `"error"` for a failure worth retrying. Kept
     *  apart from `null` because `null` is the server saying no and draws the
     *  placeholder, while a dropped connection must not be reported as one. */
    result: ForumPreview | null | "error";
  } | null>(null);

  const [copied, setCopied] = useState(false);

  const copyLink = async () => {
    const link = commentId ? forumReplyLinkFor(postId, commentId) : forumLinkFor(postId);
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access needs a secure context, which a self-hosted instance
      // reached over plain HTTP does not have. Same wording as the action bar.
      toast.error("Could not copy — clipboard needs HTTPS");
    }
  };

  useEffect(() => {
    if (peekForumPreview(postId, commentId)) return;
    let live = true;
    resolveForumPreview(postId, commentId)
      .then((value) => {
        if (live) setFetched({ key, result: value });
      })
      // The cache did not remember this, so a later mount asks again.
      .catch(() => {
        if (live) setFetched({ key, result: "error" });
      });
    return () => {
      live = false;
    };
  }, [postId, commentId]);

  // `undefined` is "no answer yet" and is not the same as either outcome.
  const result = cached
    ? cached.value
    : fetched?.key === key
      ? fetched.result
      : undefined;

  if (result === undefined || result === "error") return null;
  if (result === null) return <UnavailableForum />;
  const preview = result;

  const name = preview.author_display_name || displayUserId(preview.author);
  const where = preview.channel_name ? preview.channel_name : preview.room_name;
  const isReply = preview.kind === "reply";

  return (
    // A div wrapping two buttons rather than one button containing another:
    // nesting them is invalid, and it makes the copy click ambiguous with the
    // jump. The copy button is laid over the card instead of inside its
    // clickable subtree.
    <div className="group/forum relative mt-1 w-full max-w-[min(520px,100%)]">
      <button
        type="button"
        onClick={() => requestForumPost(preview.room_id, preview.post_id, preview.channel_id)}
        className="flex w-full flex-col gap-1 rounded-md border border-border bg-secondary/40 p-2.5 pr-9 text-left transition-colors hover:bg-secondary/70 cursor-pointer"
      >
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Book className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate font-medium">{where}</span>
          {preview.channel_name && preview.room_name && (
            <>
              <span aria-hidden>·</span>
              <span className="truncate">{preview.room_name}</span>
            </>
          )}
        </div>

        <div className="flex items-start gap-2">
          <Avatar className="h-5 w-5 shrink-0">
            <AuthAvatarImage src={preview.author_avatar_url || undefined} />
            <AvatarFallback className="text-[10px]">
              {name.slice(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            {/* The post's title is the name a link unfurls to; a reply says so
                above the post it lives under. */}
            <div className="flex items-center gap-1.5">
              {isReply && (
                <Reply className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate font-semibold text-foreground">
                {preview.title}
              </span>
            </div>
            <span className="ui-hint">
              {name}
              {isReply && " · reply"} · {new Date(preview.created_at).toLocaleString()}
              {preview.edited && " · (edited)"}
            </span>
            <div className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
              {preview.body ? (
                <span className="line-clamp-3">
                  {renderInlineEmojis(preview.body)}
                </span>
              ) : (
                <span className="italic">No text</span>
              )}
            </div>
            {!isReply && preview.comment_count > 0 && (
              <div className="mt-0.5 inline-flex items-center gap-1 ui-hint">
                <MessageSquare className="h-3 w-3" />
                {preview.comment_count} {preview.comment_count === 1 ? "reply" : "replies"}
              </div>
            )}
          </div>
        </div>
      </button>

      <button
        type="button"
        onClick={copyLink}
        aria-label="Copy forum link"
        title="Copy forum link"
        className={cn(
          "absolute right-1.5 top-1.5 rounded p-1.5 text-muted-foreground transition-opacity hover:bg-accent hover:text-foreground cursor-pointer",
          // Out of the way until hovered where hovering is possible; always
          // there on touch, which has no hover to reveal it with.
          "can-hover:opacity-0 can-hover:group-hover/forum:opacity-100 focus-visible:opacity-100",
        )}
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-emerald-500" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
      </button>
    </div>
  );
}
