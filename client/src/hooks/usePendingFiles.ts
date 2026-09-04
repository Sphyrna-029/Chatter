import { useCallback, useEffect, useRef, useState } from "react";

export interface PendingFile {
  file: File;
  /** Object URL for image previews; null for everything else. */
  previewUrl: string | null;
}

/** Attachments per message, matching the composer's staged-preview row. */
export const MAX_ATTACHMENTS = 4;

/**
 * Holds files staged on a composer until the message is actually sent, and owns
 * the lifecycle of their preview object URLs so they are always revoked.
 *
 * Size limits stay with the caller — each surface reports them its own way.
 */
export function usePendingFiles(max: number = MAX_ATTACHMENTS) {
  const [files, setFiles] = useState<PendingFile[]>([]);

  // Mirrors `files` so the unmount cleanup can revoke whatever is still staged
  // without re-running on every change.
  const filesRef = useRef<PendingFile[]>([]);
  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  const add = useCallback(
    (file: File) => {
      // Created outside the updater: React can invoke an updater twice, which
      // would strand a second object URL with nothing tracking it.
      const previewUrl = file.type.startsWith("image/") ? URL.createObjectURL(file) : null;
      setFiles((prev) => {
        if (prev.length >= max) {
          if (previewUrl) URL.revokeObjectURL(previewUrl);
          return prev;
        }
        return [...prev, { file, previewUrl }];
      });
    },
    [max],
  );

  const remove = useCallback((index: number) => {
    setFiles((prev) => {
      const next = [...prev];
      const [removed] = next.splice(index, 1);
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      return next;
    });
  }, []);

  /** Empty the row, revoking every preview URL it held. */
  const clear = useCallback(() => {
    setFiles((prev) => {
      prev.forEach((pf) => pf.previewUrl && URL.revokeObjectURL(pf.previewUrl));
      return [];
    });
  }, []);

  // Don't leak object URLs if the composer unmounts with files still staged.
  useEffect(
    () => () => {
      filesRef.current.forEach((pf) => pf.previewUrl && URL.revokeObjectURL(pf.previewUrl));
    },
    [],
  );

  return { files, add, remove, clear, isFull: files.length >= max };
}
