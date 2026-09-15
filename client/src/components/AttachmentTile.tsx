import type { ReactNode } from "react";
import { cn, formatBytes } from "@/lib/utils";
import { UploadProgressOverlay } from "./UploadProgressOverlay";
import type { FileUploadProgress } from "@/hooks/useUploadQueue";

interface AttachmentTileProps {
  file: File;
  /** Object URL for image and video previews; null for everything else. */
  previewUrl: string | null;
  progress?: FileUploadProgress;
  /** Corner controls. Positioned by the caller against this tile. */
  children?: ReactNode;
  className?: string;
}

/**
 * One attachment, drawn the same whether it is waiting on a composer or
 * already on its way.
 *
 * The staged row and the in-flight row are the same picture at different
 * moments, and having them drawn by two copies of this markup is how they
 * would come to disagree about what a file looks like.
 */
export function AttachmentTile({
  file,
  previewUrl,
  progress,
  children,
  className,
}: AttachmentTileProps) {
  return (
    <div className={cn("relative group", className)}>
      {previewUrl && file.type.startsWith("video/") ? (
        // A frame of the clip says more than a document icon and its name,
        // and the object URL is already there to draw it from.
        <video
          src={previewUrl}
          muted
          playsInline
          preload="metadata"
          className="h-16 w-16 object-cover rounded-md border border-border bg-black"
        />
      ) : previewUrl ? (
        <img
          src={previewUrl}
          alt={file.name}
          className="h-16 w-16 object-cover rounded-md border border-border"
        />
      ) : (
        <div className="h-16 w-28 flex flex-col items-center justify-center rounded-md border border-border bg-muted px-2 gap-1">
          <span className="text-lg">📄</span>
          <span className="text-xs text-muted-foreground truncate max-w-full">{file.name}</span>
          <span className="ui-hint">{formatBytes(file.size)}</span>
        </div>
      )}
      <UploadProgressOverlay progress={progress} />
      {children}
    </div>
  );
}
