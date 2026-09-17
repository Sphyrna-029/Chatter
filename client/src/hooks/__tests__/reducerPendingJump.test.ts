/**
 * A message named from outside the room it lives in.
 *
 * The target has to survive the room switch that follows it being set — that
 * is the whole reason it is in the store rather than in a prop — while not
 * surviving a switch to anywhere else, or it fires the next time its room
 * happens to come up.
 */
import { describe, it, expect } from "vitest";
import { reducer } from "@/lib/store/reducer";
import { initialState } from "@/lib/store/types";
import type { AppState, MessageTarget } from "@/lib/store/types";

const target: MessageTarget = {
  roomId: "!room:localhost",
  eventId: "$named",
  channelId: "!general:localhost",
  ts: 1000,
};

const waitingToJump = (): AppState => ({
  ...initialState,
  currentRoomId: null,
  pendingJump: target,
});

describe("a pending jump", () => {
  it("is set and cleared on its own", () => {
    const set = reducer(initialState, { type: "SET_PENDING_JUMP", payload: target });
    expect(set.pendingJump).toEqual(target);
    const cleared = reducer(set, { type: "SET_PENDING_JUMP", payload: null });
    expect(cleared.pendingJump).toBeNull();
  });

  it("survives the switch into the room it names", () => {
    // Selecting the room is how the jump gets somewhere to land; clearing the
    // target there would leave the switch and nothing else.
    const next = reducer(waitingToJump(), {
      type: "SELECT_ROOM",
      payload: "!room:localhost",
    });
    expect(next.currentRoomId).toBe("!room:localhost");
    expect(next.pendingJump).toEqual(target);
  });

  it("is dropped by a switch to any other room", () => {
    // Otherwise it sits there and fires whenever its room is next opened, on
    // a click that asked for nothing of the kind.
    const next = reducer(waitingToJump(), {
      type: "SELECT_ROOM",
      payload: "!elsewhere:localhost",
    });
    expect(next.pendingJump).toBeNull();
  });

  it("is dropped by leaving for the activity page", () => {
    // `SELECT_ROOM` with null is how the app shows no room at all.
    const next = reducer(waitingToJump(), { type: "SELECT_ROOM", payload: null });
    expect(next.pendingJump).toBeNull();
  });

  it("is left alone by picking a channel", () => {
    // The jump itself selects the channel its message is in, so a clear here
    // would undo the thing mid-flight.
    const next = reducer(
      { ...waitingToJump(), currentRoomId: "!room:localhost" },
      { type: "SELECT_CHANNEL", payload: "!other:localhost" },
    );
    expect(next.pendingJump).toEqual(target);
  });
});
