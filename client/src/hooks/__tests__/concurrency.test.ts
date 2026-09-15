import { describe, it, expect, vi } from "vitest";
import { runPool, UPLOAD_CONCURRENCY } from "@/lib/concurrency";

/** A job that resolves when told to, so overlap can be observed. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("runPool", () => {
  it("gives results back in the order it was given them", async () => {
    // The urls are posted as a message, so whichever file happened to be
    // quickest is not the one that should come first.
    const out = await runPool([30, 10, 20], 3, async (ms, index) => {
      await new Promise((r) => setTimeout(r, ms));
      return `#${index}`;
    });
    expect(out).toEqual(["#0", "#1", "#2"]);
  });

  it("starts more than one at a time", async () => {
    // The whole point: a file is not only sent, it is remuxed and probed by
    // the server, and one at a time left the uplink idle throughout.
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
    const started: number[] = [];
    const done = runPool(gates, 3, async (gate, index) => {
      started.push(index);
      await gate.promise;
      return index;
    });

    await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));
    gates.forEach((gate) => gate.resolve());
    expect(await done).toEqual([0, 1, 2]);
  });

  it("holds the rest back at the limit", async () => {
    const gates = Array.from({ length: 5 }, () => deferred<void>());
    const started: number[] = [];
    const done = runPool(gates, 2, async (gate, index) => {
      started.push(index);
      await gate.promise;
      return index;
    });

    await vi.waitFor(() => expect(started).toEqual([0, 1]));
    gates[0].resolve();
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));
    gates.forEach((gate) => gate.resolve());
    expect(await done).toEqual([0, 1, 2, 3, 4]);
  });

  it("does not let one job abandon the ones beside it", async () => {
    // A file that fails comes back as a null url; it must not take the rest of
    // the row with it, which is what a rejecting pool would do.
    const out = await runPool([1, 2, 3], 3, async (n) => {
      try {
        if (n === 2) throw new Error("no");
        return n;
      } catch {
        return null;
      }
    });
    expect(out).toEqual([1, null, 3]);
  });

  it("answers for an empty row without starting anything", async () => {
    const work = vi.fn();
    expect(await runPool([], 3, work)).toEqual([]);
    expect(work).not.toHaveBeenCalled();
  });

  it("never runs more workers than there are items", async () => {
    let live = 0;
    let most = 0;
    await runPool([1, 2], UPLOAD_CONCURRENCY, async (n) => {
      live += 1;
      most = Math.max(most, live);
      await new Promise((r) => setTimeout(r, 5));
      live -= 1;
      return n;
    });
    expect(most).toBeLessThanOrEqual(2);
  });

  it("keeps a limit of at least one when given a silly one", async () => {
    expect(await runPool([1, 2], 0, async (n) => n)).toEqual([1, 2]);
  });
});
