import { Check, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { FileUploadProgress } from "@/hooks/useUploadQueue";

/**
 * What is happening to one staged file, drawn over its own preview.
 *
 * It sits on the tile rather than in a bar of its own so that with several
 * files going up there is no question which bar belongs to which — the answer
 * is the picture underneath it.
 *
 * The parent tile must be `relative`.
 */
export function UploadProgressOverlay({
  progress,
  className,
}: {
  progress?: FileUploadProgress;
  className?: string;
}) {
  if (!progress) return null;

  const { status, pct } = progress;
  // A finished file keeps a tick for the moment before the row is cleared;
  // without it the last tile would simply stop mid-bar.
  const label =
    status === "queued" ? "Waiting" :
    status === "processing" ? "Processing" :
    status === "failed" ? "Failed" :
    status === "done" ? "" : `${pct}%`;

  return (
    <div
      className={cn(
        "absolute inset-0 flex flex-col justify-end rounded-md overflow-hidden",
        status === "failed" ? "bg-destructive/35" : "bg-black/45",
        className,
      )}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={status === "done" ? 100 : pct}
      aria-label={label || "Uploaded"}
    >
      <div className="flex flex-1 items-center justify-center">
        {status === "done" ? (
          <Check className="h-5 w-5 text-white drop-shadow" />
        ) : status === "failed" ? (
          <AlertCircle className="h-5 w-5 text-white drop-shadow" />
        ) : (
          <span className="px-1 text-3xs font-medium tabular-nums text-white drop-shadow text-center">
            {label}
          </span>
        )}
      </div>
      <div className="h-1 w-full bg-white/25">
        <div
          className={cn(
            "h-full transition-[width] duration-150",
            status === "failed" ? "bg-destructive" : "bg-primary",
            // Nothing is measurable while the server works on the file, so the
            // bar says "still going" rather than inventing a number.
            status === "processing" && "animate-pulse",
          )}
          style={{ width: status === "done" || status === "processing" ? "100%" : `${pct}%` }}
        />
      </div>
    </div>
  );
}
