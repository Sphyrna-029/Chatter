/**
 * Turning an event's two timestamps into the handful of things a person
 * actually wants to know: is it on now, when is it, and how long until then.
 *
 * Everything here takes epoch milliseconds and renders in the viewer's own
 * zone. A room spread across three countries has no other shared answer to
 * "when", so the server stores UTC and each client reads it locally.
 */

export type EventPhase = "live" | "soon" | "upcoming" | "ended";

/** How far ahead the server sends its reminder. Mirrors `REMINDER_LEAD_MS` in
 *  src/backend/routes/events.rs, and is only ever used to say so in words —
 *  the server owns the actual schedule. */
export const REMINDER_LEAD_MINUTES = 10;

/** Within this of the start, an event is "starting soon" rather than merely
 *  upcoming — close enough that someone might want to be told. */
export const SOON_MS = 60 * 60 * 1000;

/** An open-ended event is treated as running for this long once it starts,
 *  after which it stops claiming to be live. Long enough for an evening. */
export const OPEN_ENDED_RUN_MS = 4 * 60 * 60 * 1000;

export interface EventTimes {
  starts_at: number;
  /** 0 when open-ended. */
  ends_at: number;
}

/** When an event stops being on, whether or not it said so itself. */
export function endOf(event: EventTimes): number {
  return event.ends_at > 0 ? event.ends_at : event.starts_at + OPEN_ENDED_RUN_MS;
}

export function phaseOf(event: EventTimes, now = Date.now()): EventPhase {
  if (now >= endOf(event)) return "ended";
  if (now >= event.starts_at) return "live";
  if (event.starts_at - now <= SOON_MS) return "soon";
  return "upcoming";
}

/** Whole units, largest first — "2d", "3h", "15m". Used for the countdown,
 *  where the exact minute stops mattering above an hour or so. */
function coarse(ms: number): string {
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days} day${days === 1 ? "" : "s"}`;
  const weeks = Math.round(days / 7);
  return `${weeks} week${weeks === 1 ? "" : "s"}`;
}

/**
 * The one line under an event's name: "Happening now", "Starts in 20 minutes",
 * "Ended 2 hours ago". This is the sentence people read instead of doing
 * arithmetic on a date.
 */
export function relativeLabel(event: EventTimes, now = Date.now()): string {
  const phase = phaseOf(event, now);
  if (phase === "live") {
    return event.ends_at > 0
      ? `Happening now · ends in ${coarse(event.ends_at - now)}`
      : "Happening now";
  }
  if (phase === "ended") return `Ended ${coarse(now - endOf(event))} ago`;
  return `Starts in ${coarse(event.starts_at - now)}`;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** "Today", "Tomorrow", "Sat 14 Mar" — the heading a day's events sit under. */
export function dayLabel(ts: number, now = Date.now()): string {
  const date = new Date(ts);
  const today = new Date(now);
  const tomorrow = new Date(now + 86400000);
  const yesterday = new Date(now - 86400000);
  if (sameDay(date, today)) return "Today";
  if (sameDay(date, tomorrow)) return "Tomorrow";
  if (sameDay(date, yesterday)) return "Yesterday";
  const withinAYear = Math.abs(ts - now) < 300 * 86400000;
  return date.toLocaleDateString([], {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(withinAYear ? {} : { year: "numeric" }),
  });
}

/** "19:30", or "19:30 – 21:00" when the event says when it stops. */
export function timeRangeLabel(event: EventTimes): string {
  const opts: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };
  const start = new Date(event.starts_at).toLocaleTimeString([], opts);
  if (event.ends_at <= 0) return start;
  const end = new Date(event.ends_at);
  const endStr = end.toLocaleTimeString([], opts);
  // An event that runs past midnight has to say which day it lands on, or
  // "23:00 – 01:00" reads as a two-hour event that already finished.
  if (!sameDay(new Date(event.starts_at), end)) {
    return `${start} – ${endStr} (${dayLabel(event.ends_at)})`;
  }
  return `${start} – ${endStr}`;
}

/** The full stamp, for the title attribute — the exact answer, with the zone
 *  named so nobody has to guess whose clock it is. */
export function absoluteLabel(ts: number): string {
  return new Date(ts).toLocaleString([], {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

/** `YYYY-MM-DDTHH:mm` in local time, which is what `<input type="datetime-local">`
 *  reads and writes. Going through the ISO string would shift by the offset. */
export function toLocalInputValue(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The inverse. Returns NaN for an empty or unparseable value, which is how
 *  the form tells a missing date from midnight. */
export function fromLocalInputValue(value: string): number {
  if (!value) return NaN;
  return new Date(value).getTime();
}

/** The next whole half-hour, as a sensible default start for a new event. */
export function nextHalfHour(now = Date.now()): number {
  const d = new Date(now);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + (30 - (d.getMinutes() % 30)));
  return d.getTime();
}

function icsStamp(ts: number): string {
  // UTC, with the punctuation stripped — the only format the spec's DATE-TIME
  // accepts with a trailing Z.
  return new Date(ts).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** RFC 5545 folds at 75 octets and escapes these four characters; a comma or a
 *  newline in a description otherwise ends the field early. */
function icsEscape(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/**
 * The event as a calendar file, so it can leave the app and land in whatever
 * the person actually runs their week from.
 */
export function toIcs(event: {
  event_id: string;
  name: string;
  description: string;
  location: string;
  starts_at: number;
  ends_at: number;
}): string {
  const end = event.ends_at > 0 ? event.ends_at : event.starts_at + 60 * 60 * 1000;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Chatter//Events//EN",
    "BEGIN:VEVENT",
    `UID:${event.event_id}@chatter`,
    `DTSTAMP:${icsStamp(Date.now())}`,
    `DTSTART:${icsStamp(event.starts_at)}`,
    `DTEND:${icsStamp(end)}`,
    `SUMMARY:${icsEscape(event.name)}`,
  ];
  if (event.description) lines.push(`DESCRIPTION:${icsEscape(event.description)}`);
  if (event.location) lines.push(`LOCATION:${icsEscape(event.location)}`);
  lines.push("END:VEVENT", "END:VCALENDAR");
  // CRLF, not LF: some calendar clients reject the file outright otherwise.
  return lines.join("\r\n");
}
