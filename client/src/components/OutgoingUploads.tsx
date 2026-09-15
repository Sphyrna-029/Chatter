import { CornerUpRight, RotateCw, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { AttachmentTile } from "./AttachmentTile";
import {
  discardOutgoing,
  isSameTarget,
  retryOutgoing,
  type OutgoingBatch,
  type OutgoingTarget,
} from "@/lib/outgoingUploads";

interface OutgoingUploadsProps {
  batches: OutgoingBatch[];
  /** Where the viewer is, so a send going somewhere else can say where. */
  here?: OutgoingTarget;
  className?: string;
}

/**
 * Sends still on their way, drawn above the composer wherever the person has
 * got to.
 *
 * A large upload outlives the channel it was started in, and used to vanish
 * from the screen the moment its author looked at something else — the row it
 * was drawn on was cleared by the room switch, and nothing anywhere else knew
 * the send existed. Here the batches come from a module, so changing channel,
 * opening a thread or crossing to a DM leaves them alone and they keep
 * reporting in the same place.
 *
 * A batch going somewhere other than the view showing it says so. That label
 * is the whole reason this can be shown from everywhere without confusing what
 * is about to be posted where.
 */
export function OutgoingUploads({ batches, here, className }: OutgoingUploadsProps) {
  if (batches.length === 0) return null;

  return (
    <div className={cn("flex flex-col gap-2 mb-2", className)}>
      {batches.map((batch) => {
        const elsewhere = !here || !isSameTarget(batch.target, here);
        return (
          <div key={batch.id} className="flex flex-col gap-1.5">
            {elsewhere && (
              <span className="ui-hint flex items-center gap-1">
                <CornerUpRight className="h-3 w-3" />
                Sending to {batch.label}
              </span>
            )}

            <div className="flex flex-wrap items-center gap-2">
              {batch.files.map((entry) => (
                <AttachmentTile
                  key={entry.id}
                  file={entry.file}
                  previewUrl={entry.previewUrl}
                  progress={{ status: entry.status, pct: entry.pct }}
                />
              ))}

              {batch.status === "failed" && (
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => retryOutgoing(batch.id)}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-accent cursor-pointer"
                  >
                    <RotateCw className="h-3 w-3" />
                    Retry
                  </button>
                  <button
                    type="button"
                    onClick={() => discardOutgoing(batch.id)}
                    title="Discard this send"
                    className="rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-accent cursor-pointer"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </div>

            {/* The text went with the files, so a failure has to keep it
                somewhere the person can see it rather than eating it. */}
            {batch.status === "failed" && batch.body && (
              <span className="text-xs text-muted-foreground truncate">“{batch.body}”</span>
            )}
            {batch.error && (
              <span className="ui-hint text-destructive">
                {batch.error} — a retry carries on from whatever already arrived.
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
