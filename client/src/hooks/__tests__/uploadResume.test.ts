import { describe, it, expect } from "vitest";
import {
  CHUNK_MAX_ATTEMPTS,
  ChunkUploadError,
  backoffDelayMs,
  chunkRange,
  classifyChunkFailure,
  fingerprintFile,
  isSameFile,
  missingChunks,
  receivedBytes,
} from "@/lib/uploadResume";

/** Enough of a `File` for the fields a fingerprint reads. */
function fileLike(name: string, size: number, lastModified: number): File {
  return { name, size, lastModified } as File;
}

describe("fingerprintFile", () => {
  it("recognises the same file picked a second time", () => {
    expect(fingerprintFile(fileLike("holiday.mkv", 8_412_773_120, 1757894400000))).toBe(
      fingerprintFile(fileLike("holiday.mkv", 8_412_773_120, 1757894400000)),
    );
  });

  it("separates files that differ in any of the three fields", () => {
    const base = fingerprintFile(fileLike("clip.mp4", 100, 5));
    expect(fingerprintFile(fileLike("clip2.mp4", 100, 5))).not.toBe(base);
    expect(fingerprintFile(fileLike("clip.mp4", 101, 5))).not.toBe(base);
    expect(fingerprintFile(fileLike("clip.mp4", 100, 6))).not.toBe(base);
  });

  it("does not let a name run into the next field", () => {
    // A plain join on a printable separator would make these two collide, and
    // colliding means resuming onto the wrong file's chunks.
    expect(fingerprintFile(fileLike("a", 1, 23))).not.toBe(
      fingerprintFile(fileLike("a\u00001", 23, 0)),
    );
  });
});

describe("isSameFile", () => {
  const stored = { name: "holiday.mkv", size: 8_412_773_120, fingerprint: "" };
  const record = {
    ...stored,
    fingerprint: fingerprintFile(fileLike(stored.name, stored.size, 1757894400000)),
  };

  it("recognises the file a stopped upload was part-way through", () => {
    expect(isSameFile(fileLike("holiday.mkv", 8_412_773_120, 1757894400000), record)).toBe(true);
  });

  it("refuses a different file that happens to share a name", () => {
    // Resuming onto the wrong bytes splices two files into one the server
    // assembles cleanly and nobody can open — the one outcome worth refusing
    // an upload over.
    expect(isSameFile(fileLike("holiday.mkv", 8_412_773_120, 1757999999000), record)).toBe(false);
    expect(isSameFile(fileLike("holiday.mkv", 999, 1757894400000), record)).toBe(false);
    expect(isSameFile(fileLike("other.mkv", 8_412_773_120, 1757894400000), record)).toBe(false);
  });
});

describe("planning what is still owed", () => {
  it("asks for nothing when the server already has it all", () => {
    expect(missingChunks(3, [0, 1, 2])).toEqual([]);
  });

  it("fills the holes in order, not just the tail", () => {
    // A resumed upload is not always a prefix: a chunk can be refused for its
    // checksum while later ones go through.
    expect(missingChunks(5, [0, 2, 4])).toEqual([1, 3]);
  });

  it("asks for everything when nothing landed", () => {
    expect(missingChunks(3, [])).toEqual([0, 1, 2]);
  });

  it("ignores indices the server reports outside the file", () => {
    expect(missingChunks(2, [0, 1, 7])).toEqual([]);
  });

  it("cuts the last chunk short at the end of the file", () => {
    expect(chunkRange(0, 10, 25)).toEqual({ start: 0, end: 10 });
    expect(chunkRange(2, 10, 25)).toEqual({ start: 20, end: 25 });
  });

  it("measures progress in bytes, so a resume opens where it left off", () => {
    // Two full chunks and the short last one of a 25-byte file.
    expect(receivedBytes([0, 1], 10, 25)).toBe(20);
    expect(receivedBytes([2], 10, 25)).toBe(5);
    expect(receivedBytes([], 10, 25)).toBe(0);
  });
});

describe("classifyChunkFailure", () => {
  it("treats a request that got no answer as worth retrying", () => {
    // XHR reports 0 for offline, DNS failures and dropped connections — the
    // case that used to burn all three retries in three seconds.
    expect(classifyChunkFailure(0, null).kind).toBe("transient");
  });

  it("retries the server's own faults", () => {
    expect(classifyChunkFailure(500, null).kind).toBe("transient");
    expect(classifyChunkFailure(502, null).kind).toBe("transient");
  });

  it("honours a rate limit's own wait", () => {
    const failure = classifyChunkFailure(429, { error: "Slow down", retry_after_secs: 4 });
    expect(failure.kind).toBe("transient");
    expect(failure.retryAfterMs).toBe(4000);
  });

  it("re-sends a chunk that arrived corrupted", () => {
    // The length was right and the bytes were not, which sending them again is
    // exactly the fix for.
    expect(
      classifyChunkFailure(400, { error: "Chunk 3 failed its checksum" }).kind,
    ).toBe("transient");
  });

  it("starts over when the server no longer has the upload", () => {
    // Swept after a day idle. Sending the remaining chunks into nothing would
    // fail at assembly instead.
    expect(classifyChunkFailure(404, { error: "Upload not found" }).kind).toBe("restart");
  });

  it("refreshes rather than gives up on an expired token", () => {
    expect(classifyChunkFailure(401, { error: "Invalid token" }).kind).toBe("auth");
  });

  it("stops on refusals a retry cannot change", () => {
    expect(classifyChunkFailure(403, { error: "Not your upload" }).kind).toBe("permanent");
    expect(
      classifyChunkFailure(400, { error: "Chunk 9 is 50 bytes, expected 100" }).kind,
    ).toBe("permanent");
  });

  it("keeps the server's wording, which says which chunk and why", () => {
    expect(classifyChunkFailure(403, { error: "Not your upload" }).message).toBe(
      "Not your upload",
    );
    expect(classifyChunkFailure(500, null).message).toBe("Chunk upload failed");
  });

  it("is a ChunkUploadError, so a caller can tell it from a thrown string", () => {
    expect(classifyChunkFailure(500, null)).toBeInstanceOf(ChunkUploadError);
  });
});

describe("backoffDelayMs", () => {
  const half = () => 0.5;

  it("grows with each attempt", () => {
    const delays = [1, 2, 3, 4].map((attempt) => backoffDelayMs(attempt, undefined, half));
    expect(delays).toEqual([750, 1500, 3000, 6000]);
  });

  it("stops growing, so a long outage does not become an hour's wait", () => {
    expect(backoffDelayMs(20, undefined, half)).toBe(22_500);
    expect(backoffDelayMs(20, undefined, () => 1)).toBe(30_000);
  });

  it("spreads clients across the window rather than releasing them together", () => {
    // Everyone knocked off the same uplink coming back at the same instant is
    // what knocks it off again.
    expect(backoffDelayMs(3, undefined, () => 0)).toBe(2000);
    expect(backoffDelayMs(3, undefined, () => 1)).toBe(4000);
  });

  it("defers to a wait the server named", () => {
    expect(backoffDelayMs(1, 4000, half)).toBe(4000);
    // Still bounded: a server asking for an hour does not get one.
    expect(backoffDelayMs(1, 3_600_000, half)).toBe(30_000);
  });

  it("gives an interrupted upload minutes, not seconds, to come back", () => {
    const total = Array.from({ length: CHUNK_MAX_ATTEMPTS - 1 }, (_, i) =>
      backoffDelayMs(i + 1, undefined, () => 1),
    ).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(60_000);
  });
});
