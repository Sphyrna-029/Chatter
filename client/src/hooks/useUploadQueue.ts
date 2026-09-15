import { useCallback, useState } from "react";
import type { PendingFile } from "@/hooks/usePendingFiles";

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
 * Uploads a row of staged files one after another, reporting where each one has
 * got to.
 *
 * A composer used to show a single bar for the whole send, which with one file
 * was fine and with ten was a bar that reached 100% and started again under a
 * different name nine times. Progress is per file and keyed by the staged id,
 * so each tile can carry its own.
 *
 * Sequential on purpose: uploads are large, and ten at once would have them
 * fight for the same uplink and all finish last. It also means the urls come
 * back in the order they were staged, which is the order they are posted in.
 *
 * A file that fails does not stop the ones behind it — it comes back with a
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

      const outcomes: UploadOutcome[] = [];
      for (const pending of files) {
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
          outcomes.push({ file: pending, url });
        } catch {
          mark(pending.id, { status: "failed", pct: 0 });
          outcomes.push({ file: pending, url: null });
        }
      }
      return outcomes;
    },
    [],
  );

  return { progress, uploadAll, reset };
}
