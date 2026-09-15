import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PendingFile } from "@/hooks/usePendingFiles";
import { AttachmentTile } from "./AttachmentTile";
import type { UploadProgressMap } from "@/hooks/useUploadQueue";

interface PendingAttachmentsProps {
  files: PendingFile[];
  onRemove: (index: number) => void;
  className?: string;
  /** Where each file has got to, keyed by staged id. Only the composers that
   *  still upload in place pass this; the ones that hand a send to the
   *  outgoing queue show its progress there instead, so their staged row is
   *  purely what has not been sent yet. */
  progress?: UploadProgressMap;
}

/**
 * The staged-attachment row shown above a composer: files wait here until the
 * message is sent, so the text can still be edited around them.
 */
export function PendingAttachments({
  files,
  onRemove,
  className,
  progress,
}: PendingAttachmentsProps) {
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
        <AttachmentTile key={pf.id} file={pf.file} previewUrl={pf.previewUrl} progress={progress?.[pf.id]}>
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
        </AttachmentTile>
      ))}
    </div>
  );
}
