import { describe, it, expect } from "vitest";
import { reducer } from "@/lib/store/reducer";
import { initialState } from "@/lib/store/types";
import type { AppState } from "@/lib/store/types";
import type { MatrixMessage, PinnedMessage } from "@/lib/api";

const message = (eventId: string): MatrixMessage => ({
  event_id: eventId,
  sender: "@someone:localhost",
  room_id: "!room:localhost",
  origin_server_ts: 1,
  type: "m.room.message",
  content: { body: "hello", msgtype: "m.text" },
});

const pinned = (eventId: string): PinnedMessage => ({
  ...message(eventId),
  pinned_by: "@someone:localhost",
  pinned_at: 1,
});

/** A room with the same message pinned, in the timeline, and in an open thread. */
const everywhereAtOnce = (): AppState => ({
  ...initialState,
  currentRoomId: "!room:localhost",
  messages: [message("$a"), message("$reply")],
  pinnedMessages: [pinned("$a")],
  activeThreadEventId: "$root",
  threadRootMessage: message("$root"),
  threadMessages: [message("$reply"), message("$other")],
});

describe.each(["REDACT_MESSAGE", "REMOVE_MESSAGE"] as const)("%s", (type) => {
  it("takes the message out of the timeline and the pin list", () => {
    const next = reducer(everywhereAtOnce(), { type, payload: "$a" });
    expect(next.messages.map((m) => m.event_id)).toEqual(["$reply"]);
    expect(next.pinnedMessages).toEqual([]);
  });

  it("takes it out of an open thread as well", () => {
    // A message is on screen in up to three places at once, and the thread was
    // the one nothing cleared — so deleting a reply from inside a thread left
    // it sitting there until the panel was reopened.
    const next = reducer(everywhereAtOnce(), { type, payload: "$reply" });
    expect(next.threadMessages.map((m) => m.event_id)).toEqual(["$other"]);
    expect(next.messages.map((m) => m.event_id)).toEqual(["$a"]);
    // The thread itself is untouched: one of its replies went, not the thread.
    expect(next.activeThreadEventId).toBe("$root");
  });

  it("closes the thread when its root is what went", () => {
    // What is left otherwise is a panel of replies to something that is gone.
    const next = reducer(everywhereAtOnce(), { type, payload: "$root" });
    expect(next.activeThreadEventId).toBeNull();
    expect(next.threadRootMessage).toBeNull();
    expect(next.threadMessages).toEqual([]);
  });

  it("does nothing for a message this client never had", () => {
    const before = everywhereAtOnce();
    const next = reducer(before, { type, payload: "$unknown" });
    expect(next.messages).toEqual(before.messages);
    expect(next.threadMessages).toEqual(before.threadMessages);
    expect(next.activeThreadEventId).toBe("$root");
  });

  it("is safe to apply twice, since the broadcast follows the response", () => {
    // The deleter's own client now removes it on the successful DELETE, and
    // the broadcast arrives afterwards saying the same thing.
    const once = reducer(everywhereAtOnce(), { type, payload: "$reply" });
    const twice = reducer(once, { type, payload: "$reply" });
    expect(twice.messages).toEqual(once.messages);
    expect(twice.threadMessages).toEqual(once.threadMessages);
  });
});

describe("a thread's reply count", () => {
  const withAThread = (): AppState => ({
    ...initialState,
    currentRoomId: "!room:localhost",
    messages: [{ ...message("$root"), thread_reply_count: 10 }],
    channelThreads: {
      "!general:localhost": [
        { threadId: "$root", channelId: "!general:localhost", name: "Thread", replyCount: 10, lastActivityTs: 500 },
        { threadId: "$other", channelId: "!general:localhost", name: "Other", replyCount: 3, lastActivityTs: 900 },
      ],
    },
  });

  it("follows the count down on the root message", () => {
    const next = reducer(withAThread(), {
      type: "UPDATE_THREAD_REPLY_COUNT",
      payload: { eventId: "$root", count: 9 },
    });
    expect(next.messages[0].thread_reply_count).toBe(9);
  });

  it("follows it on the channel list's preview as well", () => {
    // Shown in two places, and only the badge was being kept up — so the row
    // in the channel list went on advertising what the thread used to have.
    const next = reducer(withAThread(), {
      type: "UPDATE_THREAD_REPLY_COUNT",
      payload: { eventId: "$root", count: 9 },
    });
    const previews = next.channelThreads["!general:localhost"];
    expect(previews.find((t) => t.threadId === "$root")?.replyCount).toBe(9);
    expect(previews.find((t) => t.threadId === "$other")?.replyCount).toBe(3);
  });

  it("does not lift the thread up the list for losing a reply", () => {
    // Deleting a reply is not activity. The preview's own action re-sorts by
    // timestamp, which is why this one does not go through it.
    const before = withAThread();
    const next = reducer(before, {
      type: "UPDATE_THREAD_REPLY_COUNT",
      payload: { eventId: "$root", count: 9 },
    });
    const previews = next.channelThreads["!general:localhost"];
    expect(previews.map((t) => t.threadId)).toEqual(["$root", "$other"]);
    expect(previews[0].lastActivityTs).toBe(500);
  });

  it("leaves other channels alone", () => {
    const before = {
      ...withAThread(),
      channelThreads: {
        "!general:localhost": [
          { threadId: "$root", channelId: "!general:localhost", name: "Thread", replyCount: 10, lastActivityTs: 500 },
        ],
        "!random:localhost": [
          { threadId: "$elsewhere", channelId: "!random:localhost", name: "Elsewhere", replyCount: 2, lastActivityTs: 100 },
        ],
      },
    };
    const next = reducer(before, {
      type: "UPDATE_THREAD_REPLY_COUNT",
      payload: { eventId: "$root", count: 9 },
    });
    expect(next.channelThreads["!random:localhost"][0].replyCount).toBe(2);
  });
});
