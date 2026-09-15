import { useCallback, useEffect, useMemo, useState } from "react";
import {
  apiDiscardInterruptedUpload,
  apiListInterruptedUploads,
  type InterruptedUpload,
} from "@/lib/api";
import { isSameFile } from "@/lib/uploadResume";
import { useOutgoingUploads, type OutgoingBatch } from "@/lib/outgoingUploads";

/** Nothing to resume and not being able to ask are the same outcome here, and
 *  the composer is not the place to report the difference. */
async function load(): Promise<InterruptedUpload[]> {
  try {
    return await apiListInterruptedUploads();
  } catch {
    return [];
  }
}

/**
 * Which stored uploads are actually interrupted, given what the outgoing queue
 * is working on.
 *
 * An upload actually in progress is dropped by `apiListInterruptedUploads`,
 * wherever it was started from. What is left for this to catch is a batch that
 * *failed*: it still has the file in hand and already offers a retry that
 * needs no file picker, so a second offer for the same file beside it would
 * only be a question about which one to press.
 */
export function stillInterrupted(
  stored: InterruptedUpload[],
  batches: OutgoingBatch[],
): InterruptedUpload[] {
  if (batches.length === 0) return stored;
  return stored.filter(
    (upload) =>
      !batches.some((batch) =>
        batch.files.some((entry) => isSameFile(entry.file, upload)),
      ),
  );
}

/**
 * Uploads that stopped part-way and are still finishable, for the composer to
 * offer back.
 *
 * Loaded when the composer mounts and again whenever a send finishes, which
 * are the two moments the answer changes without this hook doing anything: a
 * reload brings the list back, and an upload that just failed joins it. Each
 * entry is confirmed against the server, so this is a round trip or two and
 * not something to run on every render.
 */
export function useInterruptedUploads() {
  const [uploads, setUploads] = useState<InterruptedUpload[]>([]);
  const outgoing = useOutgoingUploads();

  useEffect(() => {
    let live = true;
    void load().then((found) => {
      if (live) setUploads(found);
    });
    return () => {
      live = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    setUploads(await load());
  }, []);

  const discard = useCallback(async (fingerprint: string) => {
    // Dropped from the list first: the DELETE goes to the server and the
    // person has already said they do not want it.
    setUploads((prev) => prev.filter((entry) => entry.fingerprint !== fingerprint));
    await apiDiscardInterruptedUpload(fingerprint);
  }, []);

  // Filtered on the way out rather than at load time, so an upload starting or
  // finishing changes the offer immediately instead of waiting for the next
  // round trip to the server.
  const offered = useMemo(() => stillInterrupted(uploads, outgoing), [uploads, outgoing]);

  return { uploads: offered, refresh, discard };
}
