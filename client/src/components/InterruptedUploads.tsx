import { useRef } from "react";
import { RotateCw, X } from "lucide-react";
import { toast } from "sonner";
import { cn, formatBytes } from "@/lib/utils";
import { isSameFile } from "@/lib/uploadResume";
import type { InterruptedUpload } from "@/lib/api";

interface InterruptedUploadsProps {
  uploads: InterruptedUpload[];
  /** Hand the file back to the composer, which stages it like any other. */
  onResume: (file: File) => void;
  onDiscard: (fingerprint: string) => void;
  className?: string;
}

/**
 * Uploads that stopped part-way, offered back above the composer.
 *
 * The chunks are still on the server for a day, so an upload broken by a
 * closed tab or a dead connection can be finished rather than sent again — but
 * only this row knows that. Without it the offer exists and nobody can reach
 * it: the person sees a send that failed, and their only move is to start a
 * multi-gigabyte upload over.
 *
 * Resuming asks for the file again, because the bytes are not what is kept —
 * storing an 8 GB video in IndexedDB would put a second copy of it on the same
 * disk. What is kept is enough to recognise the file and to know what the
 * server already has, so picking the same file carries on from there instead
 * of starting again. Picking a *different* file is refused rather than
 * silently restarted: resuming onto the wrong bytes would splice two files
 * into one that assembles cleanly and will not open.
 */
export function InterruptedUploads({
  uploads,
  onResume,
  onDiscard,
  className,
}: InterruptedUploadsProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Which row asked for the picker. One input for the list rather than one
  // per row, since only one can be open at a time anyway.
  const awaiting = useRef<InterruptedUpload | null>(null);

  if (uploads.length === 0) return null;

  const pickFor = (upload: InterruptedUpload) => {
    awaiting.current = upload;
    fileInputRef.current?.click();
  };

  const handlePicked = (file: File | undefined) => {
    const upload = awaiting.current;
    awaiting.current = null;
    if (!file || !upload) return;

    if (!isSameFile(file, upload)) {
      toast.error(
        `That is not the same file — pick ${upload.name} to carry on, or remove this upload.`,
      );
      return;
    }
    onResume(file);
  };

  return (
    <div className={cn("flex flex-col gap-1.5 mb-2", className)}>
      {uploads.map((upload) => {
        const pct = upload.size > 0 ? Math.min(100, (upload.sentBytes / upload.size) * 100) : 0;
        return (
          <div
            key={upload.fingerprint}
            className="border border-border rounded-md bg-muted/40 px-3 py-2 flex items-center gap-3"
          >
            <div className="min-w-0 flex-1 flex flex-col gap-1">
              <span className="text-xs font-medium truncate">{upload.name}</span>
              <span className="ui-hint">
                {formatBytes(upload.sentBytes)} of {formatBytes(upload.size)} uploaded — pick the
                file again to finish it
              </span>
              <div
                className="h-1 w-full rounded-full bg-border overflow-hidden"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(pct)}
                aria-label={`${upload.name} upload progress`}
              >
                <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
              </div>
            </div>
            <button
              type="button"
              onClick={() => pickFor(upload)}
              className="shrink-0 inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-accent cursor-pointer"
            >
              <RotateCw className="h-3 w-3" />
              Resume
            </button>
            <button
              type="button"
              onClick={() => onDiscard(upload.fingerprint)}
              title={`Discard the part of ${upload.name} already uploaded`}
              className="shrink-0 rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-accent cursor-pointer"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}

      <input
        ref={fileInputRef}
        type="file"
        hidden
        onChange={(e) => {
          handlePicked(e.target.files?.[0]);
          // Cleared so picking the same file twice still fires a change.
          e.target.value = "";
        }}
      />
    </div>
  );
}
