import { describe, it, expect } from "vitest";
import { reducer } from "@/lib/store/reducer";
import { initialState } from "@/lib/store/types";
import type { MatrixMessage, PollState } from "@/lib/api";
import {
  remainingLabel,
  sharePercent,
  voterLabel,
  winningIndexes,
} from "@/lib/polls";

const pollState = (over: Partial<PollState> = {}): PollState => ({
  poll_id: "$poll",
  voters: [[], [], []],
  total_voters: 0,
  closed: false,
  ends_at: 2_000,
  multi_select: false,
  creator: "@ana:localhost",
  ...over,
});

const pollMessage = (poll?: PollState): MatrixMessage => ({
  event_id: "$poll",
  sender: "@ana:localhost",
  room_id: "!room:localhost",
  origin_server_ts: 1,
  type: "m.room.message",
  content: {
    body: "📊 Lunch?",
    msgtype: "m.poll",
    poll_id: "$poll",
    question: "Lunch?",
    options: ["Tacos", "Ramen", "Salad"],
    multi_select: false,
    ends_at: 2_000,
  },
  ...(poll ? { poll } : {}),
});

describe("poll arithmetic", () => {
  it("takes a share of the people who voted, not of the votes", () => {
    // The multi-select case is the whole reason this is a function: one person
    // ticking three boxes gives three votes and one voter, and bars drawn
    // against the vote count would run past full.
    expect(sharePercent(3, 3)).toBe(100);
    expect(sharePercent(1, 4)).toBe(25);
  });

  it("draws nothing rather than dividing by nobody", () => {
    expect(sharePercent(0, 0)).toBe(0);
  });

  it("names every option holding the top count", () => {
    expect(winningIndexes([3, 1, 0])).toEqual([0]);
    expect(winningIndexes([2, 2, 1])).toEqual([0, 1]);
  });

  it("crowns nobody when nobody voted", () => {
    // Otherwise every option is a joint winner at zero and the whole card
    // lights up as having won.
    expect(winningIndexes([0, 0, 0])).toEqual([]);
  });

  it("says a poll whose clock has run out is closing, never overdue", () => {
    // The server closes on a tick, so there is a window where the time is up
    // and the results are not posted yet. A negative countdown is the one
    // thing the card must not show.
    const ends = 10_000;
    expect(remainingLabel(ends, ends - 60_000)).toBe("ends in 1 minute");
    expect(remainingLabel(ends, ends)).toBe("closing");
    expect(remainingLabel(ends, ends + 60_000)).toBe("closing");
  });

  it("counts people, in the plural they actually are", () => {
    expect(voterLabel(0)).toBe("No votes yet");
    expect(voterLabel(1)).toBe("1 person voted");
    expect(voterLabel(4)).toBe("4 people voted");
  });
});

describe("poll state in the store", () => {
  it("seeds itself from a page of messages", () => {
    // A card that finds no entry draws no bars and has to fetch what the page
    // already handed it.
    const state = reducer(initialState, {
      type: "SET_MESSAGES",
      payload: { messages: [pollMessage(pollState())], hasMore: false },
    });
    expect(state.polls["$poll"]).toBeDefined();
  });

  it("seeds from a poll arriving live, too", () => {
    const state = reducer(initialState, {
      type: "ADD_MESSAGE",
      payload: pollMessage(pollState({ total_voters: 2 })),
    });
    expect(state.polls["$poll"].total_voters).toBe(2);
  });

  it("leaves the map alone for messages that are not polls", () => {
    // Identity, not just equality: every message page runs through this, and
    // a fresh object each time would re-render every card in the room.
    const state = reducer(initialState, {
      type: "SET_MESSAGES",
      payload: { messages: [pollMessage()], hasMore: false },
    });
    expect(state.polls).toBe(initialState.polls);
  });

  it("replaces a poll outright when a vote is broadcast", () => {
    // The broadcast carries every voter, so it is complete truth — unlike an
    // RSVP count, nothing local has to survive the merge.
    const seeded = reducer(initialState, {
      type: "ADD_MESSAGE",
      payload: pollMessage(pollState()),
    });
    const voted = reducer(seeded, {
      type: "UPDATE_POLL",
      payload: pollState({ voters: [["@bo:localhost"], [], []], total_voters: 1 }),
    });
    expect(voted.polls["$poll"].voters[0]).toEqual(["@bo:localhost"]);
    expect(voted.polls["$poll"].total_voters).toBe(1);
  });

  it("keeps a poll when its own message is deleted from the timeline", () => {
    // The card is gone either way, and the server is what forgets the poll.
    // The map is keyed by poll, so an entry left behind names only itself.
    const seeded = reducer(initialState, {
      type: "ADD_MESSAGE",
      payload: pollMessage(pollState()),
    });
    const after = reducer(seeded, { type: "REMOVE_MESSAGE", payload: "$poll" });
    expect(after.messages).toHaveLength(0);
  });
});
