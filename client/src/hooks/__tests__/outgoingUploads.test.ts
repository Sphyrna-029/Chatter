import { describe, it, expect, beforeEach, vi } from "vitest";

const apiUploadFile = vi.fn();
const apiSendMessage = vi.fn();
const apiSendThreadMessage = vi.fn();
const apiCancelUpload = vi.fn();

vi.mock("@/lib/api", () => ({
  apiUploadFile: (...args: unknown[]) => apiUploadFile(...args),
  apiSendMessage: (...args: unknown[]) => apiSendMessage(...args),
  apiSendThreadMessage: (...args: unknown[]) => apiSendThreadMessage(...args),
  apiCancelUpload: (...args: unknown[]) => apiCancelUpload(...args),
}));

const {
  enqueueOutgoing,
  isSameTarget,
  outgoingUploads,
  discardOutgoing,
  retryOutgoing,
} = await import("@/lib/outgoingUploads");

function fileNamed(name: string): File {
  return new File(["x"], name, { type: "application/octet-stream" });
}

/** The batch is gone when it succeeded, and stays when it did not. */
const settled = () =>
  vi.waitFor(() => {
    const running = outgoingUploads().filter((batch) => batch.status === "running");
    expect(running).toHaveLength(0);
  });

beforeEach(() => {
  outgoingUploads()
    .slice()
    .forEach((batch) => discardOutgoing(batch.id));
  apiUploadFile.mockReset().mockResolvedValue({ url: "/external/f/one.png" });
  apiSendMessage.mockReset().mockResolvedValue(undefined);
  apiSendThreadMessage.mockReset().mockResolvedValue(undefined);
  apiCancelUpload.mockReset().mockResolvedValue(undefined);
  // jsdom has no object URLs, and the tiles ask for one per preview.
  globalThis.URL.createObjectURL = vi.fn(() => "blob:preview");
  globalThis.URL.revokeObjectURL = vi.fn();
});

describe("a send that carries files", () => {
  it("posts where it was written, not where its author has got to", async () => {
    // The whole point of the queue: the destination is read when Send is
    // pressed and carried with the work. The store's sendMessage looked up the
    // *current* room as it resolved, so a long upload delivered the message
    // into whichever channel its author had wandered into.
    enqueueOutgoing({
      target: { kind: "channel", roomId: "!general:x", channelId: "c-general" },
      label: "#general",
      body: "look at this",
      files: [fileNamed("cat.png")],
    });
    await settled();

    expect(apiSendMessage).toHaveBeenCalledTimes(1);
    const [roomId, body, , , channelId] = apiSendMessage.mock.calls[0];
    expect(roomId).toBe("!general:x");
    expect(channelId).toBe("c-general");
    expect(body).toBe("look at this\n/external/f/one.png");
  });

  it("keeps a reply in the thread it was written in", async () => {
    enqueueOutgoing({
      target: { kind: "thread", roomId: "!r:x", threadEventId: "$root" },
      label: "a thread",
      body: "",
      files: [fileNamed("clip.mp4")],
    });
    await settled();

    expect(apiSendThreadMessage).toHaveBeenCalledWith("!r:x", "$root", "/external/f/one.png");
    expect(apiSendMessage).not.toHaveBeenCalled();
  });

  it("sends files with no text as one message each", async () => {
    apiUploadFile
      .mockResolvedValueOnce({ url: "/external/a/one.png" })
      .mockResolvedValueOnce({ url: "/external/b/two.png" });
    enqueueOutgoing({
      target: { kind: "channel", roomId: "!r:x", channelId: "" },
      label: "#general",
      body: "",
      files: [fileNamed("one.png"), fileNamed("two.png")],
    });
    await settled();

    expect(apiSendMessage).toHaveBeenCalledTimes(2);
    expect(apiSendMessage.mock.calls.map((call) => call[1])).toEqual([
      "/external/a/one.png",
      "/external/b/two.png",
    ]);
  });

  it("leaves nothing behind when it lands", async () => {
    enqueueOutgoing({
      target: { kind: "channel", roomId: "!r:x", channelId: "c" },
      label: "#general",
      body: "hi",
      files: [fileNamed("cat.png")],
    });
    await settled();
    expect(outgoingUploads()).toHaveLength(0);
  });
});

describe("a send that goes wrong", () => {
  it("posts what landed and keeps only what did not", async () => {
    // The rule the staged row has always followed: a failure halfway through
    // costs the upload and not the file.
    apiUploadFile
      .mockResolvedValueOnce({ url: "/external/a/one.png" })
      .mockRejectedValueOnce(new Error("no"));
    enqueueOutgoing({
      target: { kind: "channel", roomId: "!r:x", channelId: "c" },
      label: "#general",
      body: "two pictures",
      files: [fileNamed("one.png"), fileNamed("two.png")],
    });
    await settled();

    expect(apiSendMessage).toHaveBeenCalledTimes(1);
    const [batch] = outgoingUploads();
    expect(batch.status).toBe("failed");
    expect(batch.files.map((entry) => entry.file.name)).toEqual(["two.png"]);
    // The text went out with the first picture, so a retry must not repeat it.
    expect(batch.body).toBe("");
  });

  it("keeps the text when the message itself is refused", async () => {
    apiSendMessage.mockRejectedValue(new Error("Slow mode: wait 10s"));
    enqueueOutgoing({
      target: { kind: "channel", roomId: "!r:x", channelId: "c" },
      label: "#general",
      body: "something worth keeping",
      files: [fileNamed("cat.png")],
    });
    await settled();

    const [batch] = outgoingUploads();
    expect(batch.status).toBe("failed");
    expect(batch.body).toBe("something worth keeping");
    expect(batch.error).toContain("Slow mode");
  });

  it("goes out again on a retry", async () => {
    apiSendMessage.mockRejectedValueOnce(new Error("nope"));
    const id = enqueueOutgoing({
      target: { kind: "channel", roomId: "!r:x", channelId: "c" },
      label: "#general",
      body: "hello",
      files: [fileNamed("cat.png")],
    });
    await settled();
    expect(outgoingUploads()).toHaveLength(1);

    retryOutgoing(id);
    await settled();
    expect(outgoingUploads()).toHaveLength(0);
    expect(apiSendMessage).toHaveBeenCalledTimes(2);
  });

  it("cancels the part-uploads behind a batch it is told to drop", async () => {
    apiUploadFile.mockRejectedValue(new Error("no"));
    const id = enqueueOutgoing({
      target: { kind: "channel", roomId: "!r:x", channelId: "c" },
      label: "#general",
      body: "",
      files: [fileNamed("big.mkv")],
    });
    await settled();

    discardOutgoing(id);
    expect(apiCancelUpload).toHaveBeenCalledTimes(1);
    expect(outgoingUploads()).toHaveLength(0);
  });
});

describe("isSameTarget", () => {
  it("tells one channel from another, and a thread from its room", () => {
    const channel = { kind: "channel", roomId: "!r:x", channelId: "c1" } as const;
    expect(isSameTarget(channel, { ...channel })).toBe(true);
    expect(isSameTarget(channel, { ...channel, channelId: "c2" })).toBe(false);
    expect(isSameTarget(channel, { ...channel, roomId: "!other:x" })).toBe(false);
    expect(
      isSameTarget(channel, { kind: "thread", roomId: "!r:x", threadEventId: "$a" }),
    ).toBe(false);
  });

  it("tells one thread from another in the same room", () => {
    const thread = { kind: "thread", roomId: "!r:x", threadEventId: "$a" } as const;
    expect(isSameTarget(thread, { ...thread })).toBe(true);
    expect(isSameTarget(thread, { ...thread, threadEventId: "$b" })).toBe(false);
  });
});
