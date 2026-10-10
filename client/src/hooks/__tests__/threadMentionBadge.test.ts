/**
 * @vitest-environment jsdom
 *
 * A thread's unread mention badge belongs to the thread's own row in the
 * channel list, not to the channel it hangs in: reading that channel never put
 * a reply on screen, so it must not dismiss one.
 */
import { describe, it, expect, vi } from "vitest";
import { reducer } from "@/lib/store/reducer";
import { initialState } from "@/lib/store/types";
import type { AppState, Action } from "@/lib/store/types";
import type { MatrixMessage } from "@/lib/api";

const root = (): MatrixMessage => ({
  event_id: "$root",
  sender: "@rio:localhost",
  room_id: "!room:localhost",
  origin_server_ts: 1,
  type: "m.room.message",
  content: { body: "what should we play tonight?", msgtype: "m.text" },
});

vi.mock("@/lib/notifications", async (orig) => {
  const actual = await orig<typeof import("@/lib/notifications")>();
  return { ...actual, showDesktopNotification: () => true };
});
vi.mock("@/lib/sounds", () => ({
  arrivalSound: () => "", deferArrivalSound: () => {}, playSound: () => {},
  playSoundUrl: () => {}, prewarmSounds: () => {},
}));
vi.mock("../api", () => ({ apiGetRoomMembers: vi.fn() }));
vi.mock("sonner", () => ({ toast: Object.assign(() => {}, { error: () => {}, success: () => {} }) }));

import { createWsMessageHandler } from "@/lib/store/wsHandler";

describe("the badge on a thread's row in the channel list", () => {
  const withBadge = (): AppState => ({
    ...initialState,
    currentRoomId: "!room:localhost",
    threadMentions: { "$root": 2, "$other": 1 },
  });

  it("comes from the server whole, so a reload shows what is still unread", () => {
    const next = reducer(withBadge(), {
      type: "SET_THREAD_MENTIONS",
      payload: [{ thread_id: "$root", mentions: 3 }],
    });
    expect(next.threadMentions).toEqual({ "$root": 3 });
  });

  it("ignores a thread the server says has no unread mention", () => {
    const next = reducer(withBadge(), {
      type: "SET_THREAD_MENTIONS",
      payload: [{ thread_id: "$root", mentions: 0 }],
    });
    expect(next.threadMentions).toEqual({});
  });

  it("raises when a reply names the reader", () => {
    const next = reducer(withBadge(), {
      type: "SET_THREAD_MENTION",
      payload: { threadId: "$root", hasMention: true },
    });
    expect(next.threadMentions["$root"]).toBe(3);
    expect(next.threadMentions["$other"]).toBe(1);
  });

  it("is dismissed by opening that thread, and only that thread", () => {
    const next = reducer(withBadge(), {
      type: "OPEN_THREAD",
      payload: { eventId: "$root", root: root(), messages: [] },
    });
    // Zero is the absence of a badge, the same way a channel's unread count is
    // zeroed rather than dropped.
    expect(next.threadMentions).toEqual({ "$other": 1, "$root": 0 });
  });

  it("is dismissed when the thread is deleted", () => {
    const next = reducer(withBadge(), { type: "DELETE_THREAD", payload: "$root" });
    expect(next.threadMentions).toEqual({ "$other": 1, "$root": 0 });
  });
});

const reply = {
  type: "m.thread.message",
  room_id: "!room:localhost",
  channel_id: "!general:localhost",
  sender: "@rio:localhost",
  event_id: "$reply",
  thread_id: "$root",
  thread_name: "",
  thread_root_body: "what should we play tonight?",
  content: { body: "@me you are named", msgtype: "m.text" },
  thread_reply_count: 3,
  thread_participants: [],
  origin_server_ts: 5,
};

function dispatchedThreadMentions(msg: Record<string, unknown>, state: Partial<AppState> = {}) {
  const dispatch = vi.fn();
  const ref = {
    current: { ...initialState, userId: "@me:localhost", currentRoomId: "!room:localhost", ...state } as AppState,
  };
  createWsMessageHandler(dispatch, ref, { current: {} }, { current: async () => {} }, {
    current: async () => {},
  })(msg);
  return dispatch.mock.calls
    .map(([action]) => action as Action)
    .filter((action) => action.type === "SET_THREAD_MENTION")
    .map((action) => action.payload.threadId);
}

describe("a live thread reply", () => {
  it("raises the badge when it names the reader", () => {
    expect(dispatchedThreadMentions(reply)).toEqual(["$root"]);
  });

  it("raises nothing when the reader is already reading that thread", () => {
    expect(
      dispatchedThreadMentions(reply, { activeThreadEventId: "$root" }),
    ).toEqual([]);
  });

  it("raises nothing when the reply says nothing about the reader", () => {
    expect(
      dispatchedThreadMentions({ ...reply, content: { body: "nobody named", msgtype: "m.text" } }),
    ).toEqual([]);
  });

  it("raises nothing for the reader's own reply", () => {
    expect(dispatchedThreadMentions({ ...reply, sender: "@me:localhost" })).toEqual([]);
  });
});
