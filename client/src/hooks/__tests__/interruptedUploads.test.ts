import { describe, it, expect } from "vitest";
import { stillInterrupted } from "@/hooks/useInterruptedUploads";
import { fingerprintFile } from "@/lib/uploadResume";
import type { InterruptedUpload } from "@/lib/api";
import type { OutgoingBatch, OutgoingFile } from "@/lib/outgoingUploads";

function fileNamed(name: string, size = 20_000_000): File {
  return { name, size, lastModified: 1757894400000, type: "video/mp4" } as File;
}

function storedFor(file: File): InterruptedUpload {
  return {
    fingerprint: fingerprintFile(file),
    name: file.name,
    size: file.size,
    sentBytes: 10_485_760,
    updatedAt: 1757894400000,
  };
}

function batchHolding(files: File[], status: OutgoingBatch["status"]): OutgoingBatch {
  return {
    id: "outgoing-0",
    target: { kind: "channel", roomId: "!r:x", channelId: "c" },
    label: "#general",
    body: "",
    status,
    files: files.map<OutgoingFile>((file, index) => ({
      id: `outgoing-0-${index}`,
      file,
      previewUrl: null,
      status: status === "failed" ? "failed" : "uploading",
      pct: 40,
    })),
  };
}

describe("stillInterrupted", () => {
  it("offers a stored upload when nothing is going out", () => {
    const file = fileNamed("holiday.mkv");
    expect(stillInterrupted([storedFor(file)], [])).toHaveLength(1);
  });

  it("does not offer to resume a file a batch already holds", () => {
    // A failed batch has the file in hand and its own retry, which needs no
    // file picker — a second offer beside it is only a question about which
    // button to press.
    const file = fileNamed("holiday.mkv");
    expect(stillInterrupted([storedFor(file)], [batchHolding([file], "failed")])).toEqual([]);
  });

  it("does not offer one that is uploading right now", () => {
    // The record is written after every chunk, so a healthy upload has one
    // from its first ten megabytes onward.
    const file = fileNamed("holiday.mkv");
    expect(stillInterrupted([storedFor(file)], [batchHolding([file], "running")])).toEqual([]);
  });

  it("still offers the others in the list", () => {
    const going = fileNamed("holiday.mkv");
    const stopped = fileNamed("wedding.mkv");
    const offered = stillInterrupted(
      [storedFor(going), storedFor(stopped)],
      [batchHolding([going], "running")],
    );
    expect(offered.map((entry) => entry.name)).toEqual(["wedding.mkv"]);
  });

  it("matches on the whole file, not just the name", () => {
    // A different file that happens to share a name is a different upload, and
    // hiding the offer for it would strand it.
    const stored = storedFor(fileNamed("holiday.mkv", 20_000_000));
    const other = fileNamed("holiday.mkv", 30_000_000);
    expect(stillInterrupted([stored], [batchHolding([other], "running")])).toHaveLength(1);
  });
});
