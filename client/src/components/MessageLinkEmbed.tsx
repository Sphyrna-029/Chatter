import { useEffect, useState } from "react";
import {
  Check,
  Copy,
  Hash,
  Link2Off,
  MessageSquareQuote,
  Paperclip,
} from "lucide-react";
import { toast } from "sonner";
import { useAppContext } from "@/lib/store";
import { cn, displayUserId } from "@/lib/utils";
import {
  messageLinkFor,
  peekMessagePreview,
  resolveMessagePreview,
} from "@/lib/messageLinks";
import type { MessagePreview } from "@/lib/api";
import { AuthAvatarImage } from "@/components/AuthImage";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { renderInlineEmojis } from "./EmojiPicker";

/** Stands in for a link this viewer cannot follow.
 *
 *  Says nothing about what is behind it, because nothing is known: the server
 *  answers one 404 for a message that does not exist, one in a room the caller
 *  is not in, and one in a channel they cannot see. So this is not "you are
 *  not allowed" — it is the honest extent of what there is to report, and it
 *  reads the same for a message that was deleted an hour ago.
 *
 *  It exists because the link text is suppressed from the body, and a message
 *  whose whole content was a link would otherwise render as an empty bubble.
 *  Inert on purpose: nothing to click, and no copy button, since there is
 *  nothing to be done with a link that goes nowhere for you. */
function UnavailableMessage() {
  return (
    <div className="mt-1 flex w-full max-w-[min(520px,100%)] items-center gap-2 rounded-md border border-dashed border-border bg-secondary/20 px-2.5 py-2 text-xs text-muted-foreground">
      <Link2Off className="h-3.5 w-3.5 shrink-0" />
      <span>Message unavailable</span>
    </div>
  );
}

/**
 * The card a shared message link draws under the message that shared it.
 *
 * It replaces the link in the body rather than sitting beside it: the card
 * says where the message is, who wrote it and what it says, jumps there when
 * clicked, and carries a button to copy the link back out.
 *
 * A viewer the server will not resolve the link for gets `UnavailableMessage`
 * instead, and that is the point of the feature rather than an error path: a
 * message shared out of a channel half the room cannot read gives them no
 * sender, no location and no content. Nothing is decided here — the server
 * refuses and this draws the placeholder — so there is no client-side check to
 * get wrong and nothing private in the props to leak.
 *
 * Three states, not two, and the third is why: *still resolving* renders
 * nothing, because a placeholder that appeared and then turned into a card
 * would flicker on every scroll; and a *failure worth retrying* — a dropped
 * connection, a rate limit — also renders nothing, because it is not the
 * server saying no and must not be reported as one.
 */
export function MessageLinkEmbed({ eventId }: { eventId: string }) {
  const { openMessage } = useAppContext();

  // Answered during render when this link has been resolved before, so a card
  // that scrolls out of the timeline and back does not flicker.
  const cached = peekMessagePreview(eventId);

  // Only an unresolved link needs state, and the id is kept beside the result
  // so a card whose `eventId` prop changes ignores the previous answer rather
  // than being reset by the effect.
  const [fetched, setFetched] = useState<{
    key: string;
    /** The server's answer, or `"error"` for a failure worth retrying. Kept
     *  apart from `null` because `null` is the server saying no and draws the
     *  placeholder, while a dropped connection must not be reported as one. */
    result: MessagePreview | null | "error";
  } | null>(null);

  const [copied, setCopied] = useState(false);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(messageLinkFor(eventId));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access needs a secure context, which a self-hosted instance
      // reached over plain HTTP does not have. Same wording as the action bar.
      toast.error("Could not copy — clipboard needs HTTPS");
    }
  };

  useEffect(() => {
    if (peekMessagePreview(eventId)) return;
    let live = true;
    resolveMessagePreview(eventId)
      .then((value) => {
        if (live) setFetched({ key: eventId, result: value });
      })
      // The cache did not remember this, so a later mount asks again.
      .catch(() => {
        if (live) setFetched({ key: eventId, result: "error" });
      });
    return () => {
      live = false;
    };
  }, [eventId]);

  // `undefined` is "no answer yet" and is not the same as either outcome.
  const result = cached
    ? cached.value
    : fetched?.key === eventId
      ? fetched.result
      : undefined;

  if (result === undefined || result === "error") return null;
  if (result === null) return <UnavailableMessage />;
  const preview = result;

  const name =
    preview.sender_display_name || displayUserId(preview.sender);
  const where = preview.channel_name
    ? `#${preview.channel_name}`
    : preview.room_name;

  return (
    // A div wrapping two buttons rather than one button containing another:
    // nesting them is invalid, and it makes the copy click ambiguous with the
    // jump. The copy button is laid over the card instead of inside its
    // clickable subtree.
    <div className="group/msglink relative mt-1 w-full max-w-[min(520px,100%)]">
      <button
        type="button"
        onClick={() =>
          openMessage({
            roomId: preview.room_id,
            eventId: preview.event_id,
            channelId: preview.channel_id,
            ts: preview.origin_server_ts,
          })
        }
        className="flex w-full flex-col gap-1 rounded-md border border-border bg-secondary/40 p-2.5 pr-9 text-left transition-colors hover:bg-secondary/70 cursor-pointer"
      >
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <MessageSquareQuote className="h-3.5 w-3.5 shrink-0" />
          <span className="inline-flex min-w-0 items-center gap-1">
            {preview.channel_name && <Hash className="h-3 w-3 shrink-0" />}
            <span className="truncate font-medium">{where}</span>
          </span>
          {preview.channel_name && preview.room_name && (
            <>
              <span aria-hidden>·</span>
              <span className="truncate">{preview.room_name}</span>
            </>
          )}
        </div>

        <div className="flex items-start gap-2">
          <Avatar className="h-5 w-5 shrink-0">
            <AuthAvatarImage src={preview.sender_avatar_url || undefined} />
            <AvatarFallback className="text-[10px]">
              {name.slice(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <span className="mr-1.5 text-xs font-semibold text-foreground">
              {name}
            </span>
            <span className="ui-hint">
              {new Date(preview.origin_server_ts).toLocaleString()}
            </span>
            <div className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
              {preview.spoiler ? (
                // The text never left the server for this one. A spoiler is not
                // shown until someone asks, and a card drawn in another channel
                // is the one place nobody can.
                <span className="italic">Spoiler message</span>
              ) : preview.body ? (
                <span className="line-clamp-3">
                  {renderInlineEmojis(preview.body)}
                  {preview.edited && <span className="ui-hint ml-1">(edited)</span>}
                </span>
              ) : (
                <span className="italic">No text</span>
              )}
            </div>
            {preview.attachment_count > 0 && (
              <div className="mt-0.5 inline-flex items-center gap-1 ui-hint">
                <Paperclip className="h-3 w-3" />
                {preview.attachment_count}{" "}
                {preview.attachment_count === 1 ? "attachment" : "attachments"}
              </div>
            )}
          </div>
        </div>
      </button>

      <button
        type="button"
        onClick={copyLink}
        aria-label="Copy message link"
        title="Copy message link"
        className={cn(
          "absolute right-1.5 top-1.5 rounded p-1.5 text-muted-foreground transition-opacity hover:bg-accent hover:text-foreground cursor-pointer",
          // Out of the way until hovered where hovering is possible; always
          // there on touch, which has no hover to reveal it with.
          "can-hover:opacity-0 can-hover:group-hover/msglink:opacity-100 focus-visible:opacity-100",
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
