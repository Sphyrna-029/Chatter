import { RotateCw, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PendingFile } from "@/hooks/usePendingFiles";
import { UploadProgressOverlay } from "./UploadProgressOverlay";
import type { UploadProgressMap } from "@/hooks/useUploadQueue";

function formatSize(bytes: number) {
  const MB = 1024 * 1024;
  // Chunked uploads exist for files that run to gigabytes, and "8402.5 MB" is
  // not a size anyone reads.
  if (bytes >= 1024 * MB) return `${(bytes / (1024 * MB)).toFixed(1)} GB`;
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

interface PendingAttachmentsProps {
  files: PendingFile[];
  onRemove: (index: number) => void;
  className?: string;
  /** Where each file has got to, keyed by staged id. Absent until a send. */
  progress?: UploadProgressMap;
  /** Offered on a tile that failed. Sending again picks up from whatever the
   *  server already holds, so this resumes rather than restarts. */
  onRetry?: () => void;
  /** Bytes of each failed file already on the server, keyed by staged id, so
   *  the retry says what it is going to skip. */
  resumedBytes?: Record<string, number>;
}

/**
 * The staged-attachment row shown above a composer: files wait here until the
 * message is sent, so the text can still be edited around them.
 *
 * The row stays up while the send is uploading, each tile carrying its own
 * progress — it is the only place where which file is which is already
 * obvious.
 */
export function PendingAttachments({ files, onRemove, className, progress, onRetry, resumedBytes }: PendingAttachmentsProps) {
  if (files.length === 0) return null;
  // Something actually moving, not merely something recorded: a failed tile
  // stays in the map so it can say so, and it must not go on hiding the button
  // that takes it off the row.
  const uploading = Object.values(progress ?? {}).some(
    (entry) => entry.status !== "failed" && entry.status !== "done",
  );
  return (
    <div className={cn("flex flex-wrap gap-2 mb-2", className)}>
      {files.map((pf, i) => (
        <div key={pf.id} className="relative group">
          {pf.previewUrl && pf.file.type.startsWith("video/") ? (
            // A frame of the clip says more than a document icon and its name,
            // and the object URL is already there to draw it from.
            <video
              src={pf.previewUrl}
              muted
              playsInline
              preload="metadata"
              className="h-16 w-16 object-cover rounded-md border border-border bg-black"
            />
          ) : pf.previewUrl ? (
            <img
              src={pf.previewUrl}
              alt={pf.file.name}
              className="h-16 w-16 object-cover rounded-md border border-border"
            />
          ) : (
            <div className="h-16 w-28 flex flex-col items-center justify-center rounded-md border border-border bg-muted px-2 gap-1">
              <span className="text-lg">📄</span>
              <span className="text-xs text-muted-foreground truncate max-w-full">
                {pf.file.name}
              </span>
              <span className="ui-hint">{formatSize(pf.file.size)}</span>
            </div>
          )}
          <UploadProgressOverlay progress={progress?.[pf.id]} />
          {/* A failure is worth one press, not a re-pick: the chunks already
              on the server are still there and are not sent twice. */}
          {onRetry && progress?.[pf.id]?.status === "failed" && (
            <button
              className="absolute -top-1.5 -left-1.5 h-4 w-4 rounded-full bg-primary text-primary-foreground flex items-center justify-center cursor-pointer leading-none"
              onClick={onRetry}
              title={
                resumedBytes?.[pf.id]
                  ? `Resume ${pf.file.name} — ${formatSize(resumedBytes[pf.id])} of ${formatSize(pf.file.size)} already sent`
                  : `Retry ${pf.file.name}`
              }
            >
              <RotateCw className="h-2.5 w-2.5" />
            </button>
          )}
          {/* Nothing to take back once the bytes are on their way. */}
          {!uploading && (
            <button
              className="absolute -top-1.5 -right-1.5 h-4 w-4 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center can-hover:opacity-0 can-hover:group-hover:opacity-100 transition-opacity cursor-pointer leading-none"
              onClick={() => onRemove(i)}
              title={`Remove ${pf.file.name}`}
            >
              <X className="h-2.5 w-2.5" />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
