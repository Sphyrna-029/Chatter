import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PendingFile } from "@/hooks/usePendingFiles";

function formatSize(bytes: number) {
  return bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(1)} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface PendingAttachmentsProps {
  files: PendingFile[];
  onRemove: (index: number) => void;
  className?: string;
}

/**
 * The staged-attachment row shown above a composer: files wait here until the
 * message is sent, so the text can still be edited around them.
 */
export function PendingAttachments({ files, onRemove, className }: PendingAttachmentsProps) {
  if (files.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap gap-2 mb-2", className)}>
      {files.map((pf, i) => (
        <div key={i} className="relative group">
          {pf.previewUrl ? (
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
              <span className="text-3xs text-muted-foreground/70">{formatSize(pf.file.size)}</span>
            </div>
          )}
          <button
            className="absolute -top-1.5 -right-1.5 h-4 w-4 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center can-hover:opacity-0 can-hover:group-hover:opacity-100 transition-opacity cursor-pointer leading-none"
            onClick={() => onRemove(i)}
            title={`Remove ${pf.file.name}`}
          >
            <X className="h-2.5 w-2.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
