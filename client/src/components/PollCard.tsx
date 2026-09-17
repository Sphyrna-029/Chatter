import { useEffect, useMemo, useState } from "react";
import { useAppContext } from "@/lib/store";
import type { MatrixMessage } from "@/lib/api";
import { cn, displayUserId } from "@/lib/utils";
import { canManageMessages } from "@/lib/permissions";
import {
  remainingLabel,
  sharePercent,
  voteLabel,
  voterLabel,
  winningIndexes,
} from "@/lib/polls";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { BarChart3, Check, Loader2 } from "lucide-react";
import { toast } from "sonner";

/**
 * One answer's row: the label, a bar behind it, and the count.
 *
 * The same markup for a poll that is running and for one that has finished, so
 * the two cannot come to disagree about what an answer looks like — only
 * whether it can be clicked. The bar is a background layer rather than a
 * sibling element, because the label has to sit *on* it: a bar beside the text
 * would make the row twice as tall for no more information.
 */
function OptionRow({
  label,
  count,
  percent,
  chosen,
  winner,
  voters,
  onClick,
  disabled,
}: {
  label: string;
  count: number;
  percent: number;
  chosen: boolean;
  winner: boolean;
  /** Display names of the people who picked this, for the tooltip. Empty when
   *  the card has no voter list — a results message carries only counts. */
  voters: string[];
  onClick?: () => void;
  disabled?: boolean;
}) {
  const row = (
    <div
      className={cn(
        "relative flex items-center gap-2 overflow-hidden rounded-md border px-2.5 py-1.5 text-sm",
        chosen ? "border-primary/60" : "border-border",
        onClick && !disabled
          ? "cursor-pointer transition-colors hover:border-primary/40 hover:bg-accent/40"
          : "",
      )}
    >
      <div
        aria-hidden
        className={cn(
          "absolute inset-y-0 left-0 transition-[width] duration-300",
          winner ? "bg-primary/25" : "bg-muted-foreground/15",
        )}
        style={{ width: `${percent}%` }}
      />
      <span
        className={cn(
          "relative flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
          chosen ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40",
        )}
      >
        {chosen && <Check className="h-3 w-3" />}
      </span>
      <span className={cn("relative min-w-0 flex-1 break-words", winner && "font-medium")}>
        {label}
      </span>
      <span className="relative shrink-0 tabular-nums text-xs text-muted-foreground">
        {percent}% · {count}
      </span>
    </div>
  );

  const clickable = onClick ? (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={chosen}
      className="block w-full text-left disabled:cursor-not-allowed disabled:opacity-70"
    >
      {row}
    </button>
  ) : (
    row
  );

  if (voters.length === 0) return clickable;
  const shown = voters.slice(0, 8);
  const remaining = voters.length - shown.length;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{clickable}</TooltipTrigger>
      <TooltipContent className="max-w-60">
        {shown.join(", ")}
        {remaining > 0 ? ` +${remaining} more` : ""}
      </TooltipContent>
    </Tooltip>
  );
}

function CardShell({
  title,
  children,
  footer,
}: {
  title: string;
  children: React.ReactNode;
  footer: React.ReactNode;
}) {
  return (
    <div className="mt-1 max-w-md rounded-lg border border-border bg-card/60 p-3">
      <div className="mb-2 flex items-start gap-2">
        <BarChart3 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <p className="min-w-0 flex-1 break-words font-medium leading-snug">{title}</p>
      </div>
      <div className="space-y-1.5">{children}</div>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        {footer}
      </div>
    </div>
  );
}

/**
 * A running poll.
 *
 * The question, the answers and the closing time come from the message, which
 * never changes. Everything that moves — who has voted, whether it is still
 * open — is read from the store, so one poll on screen in the timeline, a pin
 * list and a search result at once cannot show three different tallies.
 */
export function PollCard({ message }: { message: MatrixMessage }) {
  const { state, votePoll, closePoll, loadPoll } = useAppContext();
  const [pending, setPending] = useState(false);
  // Re-render on a clock of its own: the countdown is the one thing on the
  // card that changes with nothing arriving to change it.
  const [now, setNow] = useState(() => Date.now());

  const pollId = message.content.poll_id ?? message.event_id;
  const question = message.content.question ?? message.content.body;
  const options = useMemo(() => message.content.options ?? [], [message.content.options]);
  const live = state.polls[pollId];

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  // A card can arrive without state — opened from a pin, a search result, or a
  // page fetched before this feature existed. Asking for it once is what makes
  // those surfaces work without every one of them knowing about polls.
  useEffect(() => {
    if (!live) void loadPoll(pollId).catch(() => {});
  }, [live, pollId, loadPoll]);

  const voters = live?.voters ?? options.map(() => []);
  const counts = voters.map((v) => v.length);
  const totalVoters = live?.total_voters ?? 0;
  const endsAt = live?.ends_at ?? message.content.ends_at ?? 0;
  const multiSelect = live?.multi_select ?? message.content.multi_select ?? false;
  // Closed by the flag *or* by the clock: the server sweeps on a tick, so
  // there are seconds where the time is up and the record still says open.
  // Offering a vote in that window would be offering one the server refuses.
  const closed = (live?.closed ?? false) || (endsAt > 0 && now >= endsAt);

  const me = state.userId ?? "";
  const myVotes = voters.flatMap((list, index) => (list.includes(me) ? [index] : []));
  const winners = closed ? winningIndexes(counts) : [];
  const canEndEarly =
    !closed && (live?.creator === me || canManageMessages(state));

  const nameOf = (id: string) => state.userPresence[id]?.displayName || displayUserId(id);

  const cast = async (index: number) => {
    if (closed || pending) return;
    // The selection is sent whole, so a single-answer poll replaces and a
    // multi-answer one toggles — and clicking your own answer again takes it
    // back, which is the only way to withdraw a vote.
    const next = multiSelect
      ? myVotes.includes(index)
        ? myVotes.filter((i) => i !== index)
        : [...myVotes, index]
      : myVotes.includes(index)
        ? []
        : [index];
    setPending(true);
    try {
      await votePoll(pollId, next);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save your vote");
    } finally {
      setPending(false);
    }
  };

  const endNow = async () => {
    setPending(true);
    try {
      await closePoll(pollId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not end the poll");
    } finally {
      setPending(false);
    }
  };

  return (
    <CardShell
      title={question}
      footer={
        <>
          <span>{voterLabel(totalVoters)}</span>
          <span aria-hidden>·</span>
          <span>{closed ? "Final results" : remainingLabel(endsAt, now)}</span>
          {multiSelect && !closed && (
            <>
              <span aria-hidden>·</span>
              <span>Pick as many as you like</span>
            </>
          )}
          {pending && <Loader2 className="h-3 w-3 animate-spin" />}
          {canEndEarly && (
            <button
              type="button"
              onClick={endNow}
              disabled={pending}
              className="ml-auto cursor-pointer underline-offset-2 hover:text-foreground hover:underline disabled:cursor-not-allowed"
            >
              End now
            </button>
          )}
        </>
      }
    >
      {options.map((option, index) => (
        <OptionRow
          key={index}
          label={option}
          count={counts[index] ?? 0}
          percent={sharePercent(counts[index] ?? 0, totalVoters)}
          chosen={myVotes.includes(index)}
          winner={winners.includes(index)}
          voters={(voters[index] ?? []).map(nameOf)}
          onClick={closed ? undefined : () => void cast(index)}
          disabled={pending}
        />
      ))}
    </CardShell>
  );
}

/**
 * The message posted when a poll ends.
 *
 * Drawn from its own content and nothing else. It has to read correctly in a
 * search result years later, and the poll it came from may well have been
 * deleted by then — so it carries the question, the answers and the numbers
 * rather than pointing at a record.
 */
export function PollResultsCard({ message }: { message: MatrixMessage }) {
  const question = message.content.question ?? message.content.body;
  const options = message.content.options ?? [];
  const counts = message.content.counts ?? [];
  const totalVoters = message.content.total_voters ?? 0;
  const winners = winningIndexes(counts);

  return (
    <CardShell
      title={question}
      footer={
        <>
          <span className="font-medium text-foreground/80">Poll closed</span>
          <span aria-hidden>·</span>
          <span>{voterLabel(totalVoters)}</span>
          {winners.length > 1 && (
            <>
              <span aria-hidden>·</span>
              <span>Tied at {voteLabel(counts[winners[0]] ?? 0)}</span>
            </>
          )}
        </>
      }
    >
      {options.map((option, index) => (
        <OptionRow
          key={index}
          label={option}
          count={counts[index] ?? 0}
          percent={sharePercent(counts[index] ?? 0, totalVoters)}
          chosen={false}
          winner={winners.includes(index)}
          voters={[]}
        />
      ))}
    </CardShell>
  );
}
