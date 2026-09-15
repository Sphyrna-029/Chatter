/**
 * Run `work` over `items` with at most `limit` of them in flight, and give the
 * results back in the order the items were given — not the order they
 * finished.
 *
 * That ordering is the whole reason this is not a `Promise.all` with a
 * semaphore bolted on: a row of attachments is posted in the order it was
 * staged, and a batch that came back in completion order would reorder
 * someone's pictures according to how fast each one happened to upload.
 *
 * `work` is never given the chance to reject the pool: a thrown error is the
 * caller's to model in `R`, because one file failing must not abandon the
 * files behind it.
 */
export async function runPool<T, R>(
  items: T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;

  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await work(items[index], index);
    }
  };

  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}

/**
 * How many files go up at once.
 *
 * Not one, which is what this was: a batch waited for each file to be *sent*
 * and then for the server to remux it, with the uplink sitting idle through
 * the second half — the slowest possible way to put ten files somewhere.
 *
 * Not all of them either. Ten transfers sharing one uplink all finish at about
 * the time the last one would have anyway, while each `complete` starts an
 * ffmpeg pass on a server whose media jobs are uncapped, and every chunk in
 * flight is a buffer held in memory to be hashed. Three keeps the link busy
 * and the first files arriving early.
 */
export const UPLOAD_CONCURRENCY = 3;
