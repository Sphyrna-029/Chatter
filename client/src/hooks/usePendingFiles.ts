import { useCallback, useEffect, useRef, useState } from "react";

export interface PendingFile {
  file: File;
  /** Object URL for image previews; null for everything else. */
  previewUrl: string | null;
}

/** Attachments per message, matching the composer's staged-preview row. */
export const MAX_ATTACHMENTS = 10;

export interface StageResult {
  /** How many of the offered files were taken. */
  added: number;
  /** How many were turned away because the row was already full. */
  rejected: number;
}

/**
 * How much of an offered batch fits, given what the row already holds.
 *
 * Pulled out of the hook because it is the whole of what went wrong before: a
 * batch was judged one file at a time against a count that only refreshed on
 * the next render, so every file in a drop saw an empty row and the ones past
 * the cap were discarded with nothing said about it.
 */
export function planStaging(
  staged: number,
  incoming: number,
  max: number,
): { accepted: number; rejected: number } {
  const accepted = Math.max(0, Math.min(incoming, max - staged));
  return { accepted, rejected: incoming - accepted };
}

/**
 * Holds files staged on a composer until the message is actually sent, and owns
 * the lifecycle of their preview object URLs so they are always revoked.
 *
 * Size limits stay with the caller — each surface reports them its own way.
 */
export function usePendingFiles(max: number = MAX_ATTACHMENTS) {
  const [files, setFiles] = useState<PendingFile[]>([]);

  // Written the moment the row changes rather than from an effect, so a second
  // call in the same tick sees what the first one staged. Callers used to
  // measure the row from render state and stage one file at a time, which
  // meant every file in a dropped batch was judged against the row as it stood
  // before any of them landed: the count check passed for all ten, and
  // everything past the cap was then dropped in here without a word.
  const filesRef = useRef<PendingFile[]>([]);
  const commit = useCallback((next: PendingFile[]) => {
    filesRef.current = next;
    setFiles(next);
  }, []);

  /**
   * Stage as many of `incoming` as there is room for, in order, and say how
   * many did not fit so the caller can explain the difference.
   */
  const addMany = useCallback(
    (incoming: File[]): StageResult => {
      const plan = planStaging(filesRef.current.length, incoming.length, max);
      const accepted = incoming.slice(0, plan.accepted);
      if (accepted.length > 0) {
        commit([
          ...filesRef.current,
          ...accepted.map((file) => ({
            file,
            // Created here rather than inside a state updater: React can invoke
            // an updater twice, which would strand a second object URL with
            // nothing tracking it.
            previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
          })),
        ]);
      }
      return { added: accepted.length, rejected: plan.rejected };
    },
    [max, commit],
  );

  /** Stage one file; false when the row was already full. */
  const add = useCallback((file: File) => addMany([file]).added === 1, [addMany]);

  const remove = useCallback(
    (index: number) => {
      const next = [...filesRef.current];
      const [removed] = next.splice(index, 1);
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      commit(next);
    },
    [commit],
  );

  /** Empty the row, revoking every preview URL it held. */
  const clear = useCallback(() => {
    filesRef.current.forEach((pf) => pf.previewUrl && URL.revokeObjectURL(pf.previewUrl));
    commit([]);
  }, [commit]);

  // Don't leak object URLs if the composer unmounts with files still staged.
  useEffect(
    () => () => {
      filesRef.current.forEach((pf) => pf.previewUrl && URL.revokeObjectURL(pf.previewUrl));
    },
    [],
  );

  return {
    files,
    add,
    addMany,
    remove,
    clear,
    isFull: files.length >= max,
    /** Slots left on this message. */
    remaining: Math.max(0, max - files.length),
    max,
  };
}
