/**
 * The authenticated-media blob cache.
 *
 * Two properties matter and neither is visible from a render: a URL already
 * resolved is answered without a fetch (which is what removes the pop-in on
 * every remount), and a blob is never revoked while an <img> still points at
 * it (which is what stops that fix from showing broken images instead).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  peekMediaBlob,
  retainMediaBlob,
  loadMediaBlob,
  releaseMediaBlob,
  forgetMediaBlob,
  clearMediaBlobs,
  mediaBlobCacheSize,
} from "@/lib/mediaBlobs";

/** jsdom has no object-URL implementation, so revocation is observed rather
 *  than performed. */
let revoked: string[] = [];

beforeEach(() => {
  clearMediaBlobs();
  revoked = [];
  URL.revokeObjectURL = vi.fn((url: string) => {
    revoked.push(url);
  });
});

/** A fetcher that answers with a predictable "blob URL" and counts calls. */
function stubFetcher() {
  const calls: string[] = [];
  const fetcher = (url: string) => {
    calls.push(url);
    return Promise.resolve(`blob:${url}#${calls.length}`);
  };
  return { fetcher, calls };
}

describe("media blob cache", () => {
  it("answers a second mount without fetching again", async () => {
    const { fetcher, calls } = stubFetcher();

    const first = await loadMediaBlob("/external/a/pic.png", fetcher);
    releaseMediaBlob("/external/a/pic.png"); // the first mount goes away

    // This is the render-time lookup: the point of the cache is that it can
    // be answered before any effect runs, so nothing renders empty.
    expect(peekMediaBlob("/external/a/pic.png")).toBe(first);
    expect(retainMediaBlob("/external/a/pic.png")).toBe(first);
    expect(calls).toHaveLength(1);
  });

  it("shares one fetch between everyone who asks during it", async () => {
    const { calls } = stubFetcher();
    let release!: (value: string) => void;
    const slow = (url: string) => {
      calls.push(url);
      return new Promise<string>((res) => {
        release = res;
      });
    };

    // A room where forty members have the same avatar mounts forty of these.
    const waiters = Promise.all([
      loadMediaBlob("/external/a/same.png", slow),
      loadMediaBlob("/external/a/same.png", slow),
      loadMediaBlob("/external/a/same.png", slow),
    ]);
    release("blob:shared");
    const results = await waiters;

    expect(calls).toHaveLength(1);
    expect(results).toEqual(["blob:shared", "blob:shared", "blob:shared"]);
  });

  it("keeps a blob alive while something is still pointing at it", async () => {
    const { fetcher } = stubFetcher();
    const url = "/external/a/held.png";

    const objectUrl = await loadMediaBlob(url, fetcher); // one reference
    retainMediaBlob(url); // a second component mounts
    releaseMediaBlob(url); // the first unmounts

    forgetMediaBlob(url);
    expect(revoked).not.toContain(objectUrl);
  });

  it("releases a blob once nothing holds it", async () => {
    const { fetcher } = stubFetcher();
    const url = "/external/a/idle.png";

    const objectUrl = await loadMediaBlob(url, fetcher);
    releaseMediaBlob(url);

    forgetMediaBlob(url);
    expect(revoked).toContain(objectUrl);
  });

  it("does not remember a failure", async () => {
    // Same reasoning as the server refusing to put freshness on a 404: a
    // preview whose source has not been generated yet fails now and succeeds
    // on a later load. Caching the failure would make the empty frame
    // permanent on this client alone.
    let attempts = 0;
    const flaky = (url: string) => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new Error("not generated yet"))
        : Promise.resolve(`blob:${url}`);
    };

    await expect(loadMediaBlob("/external/a/late.webp", flaky)).rejects.toThrow();
    expect(peekMediaBlob("/external/a/late.webp")).toBeNull();
    expect(mediaBlobCacheSize()).toBe(0);

    await expect(loadMediaBlob("/external/a/late.webp", flaky)).resolves.toBe(
      "blob:/external/a/late.webp",
    );
    expect(attempts).toBe(2);
  });

  it("evicts idle entries but never one in use", async () => {
    const { fetcher } = stubFetcher();

    // One entry nothing will give back, plus enough idle ones to go well past
    // the bound.
    const pinned = await loadMediaBlob("/external/pinned/a.png", fetcher);
    for (let i = 0; i < 260; i += 1) {
      const url = `/external/idle/${i}.png`;
      await loadMediaBlob(url, fetcher);
      releaseMediaBlob(url);
    }

    expect(peekMediaBlob("/external/pinned/a.png")).toBe(pinned);
    expect(revoked).not.toContain(pinned);
    // The oldest idle entries are the ones that went.
    expect(peekMediaBlob("/external/idle/0.png")).toBeNull();
    expect(mediaBlobCacheSize()).toBeLessThanOrEqual(193);
  });

  it("drops everything idle on sign-out", async () => {
    const { fetcher } = stubFetcher();
    const a = await loadMediaBlob("/external/a/one.png", fetcher);
    releaseMediaBlob("/external/a/one.png");
    const b = await loadMediaBlob("/external/a/two.png", fetcher);
    releaseMediaBlob("/external/a/two.png");

    clearMediaBlobs();

    expect(revoked).toContain(a);
    expect(revoked).toContain(b);
    expect(mediaBlobCacheSize()).toBe(0);
    expect(peekMediaBlob("/external/a/one.png")).toBeNull();
  });
});
