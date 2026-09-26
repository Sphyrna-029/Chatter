/**
 * @vitest-environment jsdom
 *
 * The channel list names an unnamed thread after the message that started it.
 * A live reply used to rename the row after itself.
 */
import { describe, it, expect, vi } from "vitest";
import { initialState } from "@/lib/store/types";
import type { AppState, Action } from "@/lib/store/types";

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

function previewNameAfter(msg: Record<string, unknown>, state: Partial<AppState> = {}) {
  const dispatch = vi.fn();
  const ref = {
    current: { ...initialState, userId: "@me:x", currentRoomId: "!r:x", ...state } as AppState,
  };
  createWsMessageHandler(dispatch, ref, { current: {} }, { current: async () => {} }, {
    current: async () => {},
  })(msg);
  const activity = dispatch.mock.calls
    .map(([action]) => action as Action)
    .find((action) => action.type === "THREAD_ACTIVITY");
  return activity && activity.type === "THREAD_ACTIVITY" ? activity.payload.name : undefined;
}

const reply = {
  type: "m.thread.message",
  room_id: "!r:x",
  channel_id: "c1",
  sender: "@rio:x",
  event_id: "$reply",
  thread_id: "$root",
  thread_name: "",
  thread_root_body: "what should we play tonight?",
  content: { body: "lol", msgtype: "m.text" },
  thread_reply_count: 3,
  thread_participants: [],
  origin_server_ts: 5,
};

describe("a thread's row in the channel list", () => {
  it("shows the message that started the thread, not the newest reply", () => {
    expect(previewNameAfter(reply)).toBe("what should we play tonight?");
  });

  it("shows the thread's name when it has one", () => {
    expect(previewNameAfter({ ...reply, thread_name: "Game night" })).toBe("Game night");
  });

  it("keeps the row's name when the broadcast does not carry the root", () => {
    const { thread_root_body: _omit, ...older } = reply;
    void _omit;
    expect(
      previewNameAfter(older, {
        channelThreads: {
          c1: [{ threadId: "$root", channelId: "c1", name: "what should we play tonight?", replyCount: 2, lastActivityTs: 1 }],
        },
      }),
    ).toBe("what should we play tonight?");
  });
});
