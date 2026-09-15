import { useCallback, useEffect, useState } from "react";
import {
  apiDiscardInterruptedUpload,
  apiListInterruptedUploads,
  type InterruptedUpload,
} from "@/lib/api";

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

  return { uploads, refresh, discard };
}
