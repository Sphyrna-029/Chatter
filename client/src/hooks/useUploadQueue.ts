import { useCallback, useState } from "react";
import type { PendingFile } from "@/hooks/usePendingFiles";
import { runPool, UPLOAD_CONCURRENCY } from "@/lib/concurrency";

export type UploadStatus = "queued" | "uploading" | "processing" | "done" | "failed";

export interface FileUploadProgress {
  status: UploadStatus;
  /** 0-100. Meaningless once the status is "processing" or later. */
  pct: number;
}

export type UploadProgressMap = Record<string, FileUploadProgress>;

export interface UploadOutcome {
  file: PendingFile;
  /** The uploaded URL, or null if this one failed. */
  url: string | null;
}

/**
 * Uploads a row of staged files, several at a time, reporting where each one
 * has got to.
 *
 * A composer used to show a single bar for the whole send, which with one file
 * was fine and with ten was a bar that reached 100% and started again under a
 * different name nine times. Progress is per file and keyed by the staged id,
 * so each tile can carry its own.
 *
 * This ran one file at a time, on the reasoning that ten transfers would fight
 * for one uplink. What that missed is that a file is not only sent: the server
 * remuxes and probes it while the link sits idle, so a row of files spent most
 * of its time sending nothing at all. A few at once keeps the link busy
 * without ten transfers all finishing last; `runPool` hands the urls back in
 * staged order, which is the order they are posted in.
 *
 * A file that fails does not stop the ones beside it — it comes back with a
 * null url and its tile says so, leaving the caller to decide whether a partial
 * send is worth making.
 */
export function useUploadQueue() {
  const [progress, setProgress] = useState<UploadProgressMap>({});

  const reset = useCallback(() => setProgress({}), []);

  const uploadAll = useCallback(
    async (
      files: PendingFile[],
      upload: (file: File, onProgress: (pct: number) => void) => Promise<string>,
    ): Promise<UploadOutcome[]> => {
      // Everything shows as waiting from the start, so the row reads as a queue
      // rather than as one file uploading and the rest looking untouched.
      setProgress(
        Object.fromEntries(
          files.map((pending) => [pending.id, { status: "queued" as const, pct: 0 }]),
        ),
      );

      const mark = (id: string, next: FileUploadProgress) =>
        setProgress((prev) => ({ ...prev, [id]: next }));

      return runPool(files, UPLOAD_CONCURRENCY, async (pending) => {
        mark(pending.id, { status: "uploading", pct: 0 });
        try {
          const url = await upload(pending.file, (pct) => {
            // At 100% the bytes are in and the server takes over — remuxing a
            // video can take longer than sending it did, and a bar sitting at
            // 100% looks like a hang.
            mark(
              pending.id,
              pct >= 100 ? { status: "processing", pct: 100 } : { status: "uploading", pct },
            );
          });
          mark(pending.id, { status: "done", pct: 100 });
          return { file: pending, url };
        } catch {
          mark(pending.id, { status: "failed", pct: 0 });
          return { file: pending, url: null };
        }
      });
    },
    [],
  );

  return { progress, uploadAll, reset };
}
