import { describe, expect, it } from "vitest";
import {
  OPEN_ENDED_RUN_MS,
  SOON_MS,
  dayLabel,
  endOf,
  fromLocalInputValue,
  nextHalfHour,
  phaseOf,
  relativeLabel,
  timeRangeLabel,
  toIcs,
  toLocalInputValue,
} from "@/lib/eventTime";

const NOW = new Date("2026-03-14T12:00:00").getTime();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("phaseOf", () => {
  it("calls an event live between its start and its end", () => {
    const e = { starts_at: NOW - HOUR, ends_at: NOW + HOUR };
    expect(phaseOf(e, NOW)).toBe("live");
  });

  it("treats an open-ended event as over once it has run its course", () => {
    const started = { starts_at: NOW - OPEN_ENDED_RUN_MS + MIN, ends_at: 0 };
    expect(phaseOf(started, NOW)).toBe("live");
    const stale = { starts_at: NOW - OPEN_ENDED_RUN_MS - MIN, ends_at: 0 };
    // Without this an event nobody closed would head the list forever.
    expect(phaseOf(stale, NOW)).toBe("ended");
  });

  it("separates soon from merely upcoming at the hour mark", () => {
    expect(phaseOf({ starts_at: NOW + SOON_MS - MIN, ends_at: 0 }, NOW)).toBe("soon");
    expect(phaseOf({ starts_at: NOW + SOON_MS + MIN, ends_at: 0 }, NOW)).toBe("upcoming");
  });

  it("ends exactly at the end time, not a moment after", () => {
    const e = { starts_at: NOW - HOUR, ends_at: NOW };
    expect(phaseOf(e, NOW)).toBe("ended");
  });
});

describe("endOf", () => {
  it("uses the stated end when there is one", () => {
    expect(endOf({ starts_at: NOW, ends_at: NOW + HOUR })).toBe(NOW + HOUR);
  });
  it("invents one for an open-ended event", () => {
    expect(endOf({ starts_at: NOW, ends_at: 0 })).toBe(NOW + OPEN_ENDED_RUN_MS);
  });
});

describe("relativeLabel", () => {
  it("says an event is on rather than counting toward it", () => {
    expect(relativeLabel({ starts_at: NOW - MIN, ends_at: 0 }, NOW)).toBe("Happening now");
  });

  it("counts down to the end of a live event that has one", () => {
    expect(relativeLabel({ starts_at: NOW - MIN, ends_at: NOW + 2 * HOUR }, NOW)).toBe(
      "Happening now · ends in 2 hours",
    );
  });

  it("counts in whole units, singular where it should be", () => {
    expect(relativeLabel({ starts_at: NOW + MIN, ends_at: 0 }, NOW)).toBe("Starts in 1 minute");
    expect(relativeLabel({ starts_at: NOW + 45 * MIN, ends_at: 0 }, NOW)).toBe(
      "Starts in 45 minutes",
    );
    expect(relativeLabel({ starts_at: NOW + DAY, ends_at: 0 }, NOW)).toBe("Starts in 1 day");
    expect(relativeLabel({ starts_at: NOW + 21 * DAY, ends_at: 0 }, NOW)).toBe("Starts in 3 weeks");
  });

  it("looks backwards once the event is over", () => {
    const e = { starts_at: NOW - 5 * HOUR, ends_at: NOW - 2 * HOUR };
    expect(relativeLabel(e, NOW)).toBe("Ended 2 hours ago");
  });
});

describe("dayLabel", () => {
  it("names the days nobody wants a date for", () => {
    expect(dayLabel(NOW, NOW)).toBe("Today");
    expect(dayLabel(NOW + DAY, NOW)).toBe("Tomorrow");
    expect(dayLabel(NOW - DAY, NOW)).toBe("Yesterday");
  });

  it("falls back to a real date further out", () => {
    const label = dayLabel(NOW + 10 * DAY, NOW);
    expect(label).not.toBe("Today");
    expect(label).toMatch(/Mar/);
  });
});

describe("timeRangeLabel", () => {
  it("gives one time for an open-ended event", () => {
    expect(timeRangeLabel({ starts_at: NOW, ends_at: 0 })).not.toContain("–");
  });

  it("gives a range when there is an end", () => {
    expect(timeRangeLabel({ starts_at: NOW, ends_at: NOW + HOUR })).toContain("–");
  });

  it("names the day when the event runs past midnight", () => {
    // "23:00 – 01:00" alone reads as a two-hour event that already finished.
    const late = new Date("2026-03-14T23:00:00").getTime();
    const label = timeRangeLabel({ starts_at: late, ends_at: late + 2 * HOUR });
    expect(label).toMatch(/\(/);
  });
});

describe("datetime-local round trip", () => {
  it("survives the trip without drifting by the UTC offset", () => {
    const ts = new Date("2026-03-14T19:30:00").getTime();
    expect(fromLocalInputValue(toLocalInputValue(ts))).toBe(ts);
  });

  it("reports a missing value as NaN rather than midnight", () => {
    expect(Number.isNaN(fromLocalInputValue(""))).toBe(true);
  });
});

describe("nextHalfHour", () => {
  it("rounds up to the next :00 or :30", () => {
    const at1201 = new Date("2026-03-14T12:01:00").getTime();
    expect(new Date(nextHalfHour(at1201)).getMinutes()).toBe(30);
    const at1231 = new Date("2026-03-14T12:31:00").getTime();
    const rounded = new Date(nextHalfHour(at1231));
    expect(rounded.getMinutes()).toBe(0);
    expect(rounded.getHours()).toBe(13);
  });

  it("always lands in the future, never on the current instant", () => {
    const onTheHour = new Date("2026-03-14T12:00:00").getTime();
    expect(nextHalfHour(onTheHour)).toBeGreaterThan(onTheHour);
  });
});

describe("toIcs", () => {
  const base = {
    event_id: "evt_1",
    name: "Board games",
    description: "",
    location: "",
    starts_at: NOW,
    ends_at: NOW + 2 * HOUR,
  };

  it("emits the fields a calendar needs, CRLF separated", () => {
    const ics = toIcs(base);
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("SUMMARY:Board games");
    expect(ics).toContain("UID:evt_1@chatter");
    expect(ics.endsWith("END:VCALENDAR")).toBe(true);
    expect(ics).toContain("\r\n");
  });

  it("gives an open-ended event an hour so the file stays valid", () => {
    const ics = toIcs({ ...base, ends_at: 0 });
    expect(ics).toMatch(/DTEND:\d{8}T\d{6}Z/);
  });

  it("escapes the characters that would end a field early", () => {
    const ics = toIcs({
      ...base,
      description: "Bring dice, snacks;\nand a friend",
      location: "Hall A, upstairs",
    });
    expect(ics).toContain("\\,");
    expect(ics).toContain("\\;");
    expect(ics).toContain("\\n");
    // The literal newline must not survive into the field.
    expect(ics).not.toMatch(/DESCRIPTION:[^\r]*\n[^\r]/);
  });
});
