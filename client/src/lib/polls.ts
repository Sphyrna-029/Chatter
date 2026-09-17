/**
 * What a poll means, in one place.
 *
 * The composer, the live card and the results card all have to agree about
 * how long a poll may run, what counts as winning and what a bar is a
 * percentage *of* — and the last of those is the one that is easy to get
 * wrong, since a multi-select poll has more votes than voters.
 *
 * The limits here mirror `src/backend/routes/polls.rs`. They exist to keep the
 * composer from offering something the server will refuse; the server remains
 * the authority and re-checks every one of them.
 */

export const MAX_QUESTION_LEN = 300;
export const MAX_OPTION_LEN = 100;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 10;

/** How long a poll may run, as the composer offers it. The last of these is
 *  the server's `MAX_DURATION_MINUTES`. */
export const DURATION_CHOICES: { label: string; minutes: number }[] = [
  { label: "5 minutes", minutes: 5 },
  { label: "30 minutes", minutes: 30 },
  { label: "1 hour", minutes: 60 },
  { label: "4 hours", minutes: 60 * 4 },
  { label: "8 hours", minutes: 60 * 8 },
  { label: "1 day", minutes: 60 * 24 },
  { label: "3 days", minutes: 60 * 24 * 3 },
  { label: "1 week", minutes: 60 * 24 * 7 },
];

/** Whole units, largest first. A poll with hours left does not need its
 *  minutes; one with minutes left does. */
function coarse(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

/**
 * The countdown on an open poll.
 *
 * A poll past its end but not yet swept says "closing" rather than a negative
 * time: the server closes on a tick, so there is a window of seconds where the
 * clock has run out and the results have not been posted yet. Claiming it
 * still has time left would be the one lie the card can actually tell.
 */
export function remainingLabel(endsAt: number, now = Date.now()): string {
  if (now >= endsAt) return "closing";
  return `ends in ${coarse(endsAt - now)}`;
}

/** How wide a bar is drawn, as a whole percentage. Of the number of *people*
 *  who voted, never the number of votes: in a multi-select poll one person
 *  ticking three boxes would otherwise push the bars past full. */
export function sharePercent(count: number, totalVoters: number): number {
  if (totalVoters <= 0) return 0;
  return Math.round((count / totalVoters) * 100);
}

/** Every option holding the top count — several, when it was a tie, and none
 *  at all when nobody voted. */
export function winningIndexes(counts: number[]): number[] {
  const top = Math.max(0, ...counts);
  if (top === 0) return [];
  return counts.flatMap((count, index) => (count === top ? [index] : []));
}

/** "3 votes", "1 vote" — the count under an option. */
export function voteLabel(count: number): string {
  return `${count} vote${count === 1 ? "" : "s"}`;
}

/** "7 people voted", for the line under the bars. */
export function voterLabel(totalVoters: number): string {
  if (totalVoters === 0) return "No votes yet";
  return `${totalVoters} ${totalVoters === 1 ? "person" : "people"} voted`;
}
