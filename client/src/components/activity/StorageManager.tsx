import { useEffect, useState } from "react";
import { useAppContext } from "@/lib/store";
import { apiListUploads, apiDeleteUpload, type UploadRecord } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { HardDrive, ChevronDown, Trash2 } from "lucide-react";
import { toast } from "sonner";

interface StorageManagerProps {
  refreshKey: number;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** The usage bar plus the files behind it. A gauge you cannot act on is not
 *  much help when it turns red, so the largest uploads are deletable here. */
export function StorageManager({ refreshKey }: StorageManagerProps) {
  const { state } = useAppContext();
  const [uploads, setUploads] = useState<UploadRecord[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiListUploads()
      .then((files) => { if (!cancelled) setUploads(files); })
      .catch(() => { /* leave the last known listing in place */ });
    return () => { cancelled = true; };
  }, [refreshKey]);

  // 0 means unlimited, which is the default. Returning null on that hid the
  // whole section — file list included — on every server without a quota, so
  // there was nowhere to tidy uploads from at all.
  const limit = state.storageLimitBytes;
  const hasQuota = limit > 0;
  const used = uploads.reduce((sum, f) => sum + (f.size || 0), 0);
  const ratio = hasQuota ? used / limit : 0;
  // Biggest first — reclaiming space means starting at the top. All of them,
  // not a top ten: the point of the list is cleaning up.
  const largest = [...uploads].sort((a, b) => b.size - a.size);

  if (uploads.length === 0) return null;

  async function handleDelete(file: UploadRecord) {
    setDeleting(file.url);
    try {
      await apiDeleteUpload(file.url);
      setUploads((prev) => prev.filter((f) => f.url !== file.url));
      toast.success(`Deleted ${file.filename}`);
    } catch {
      toast.error(`Could not delete ${file.filename}`);
    } finally {
      setDeleting(null);
    }
  }

  return (
    <section className="rounded-lg border border-border p-4 space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          <HardDrive className="h-4 w-4" />
          Storage
        </h2>
        <span className="text-xs text-muted-foreground">
          {hasQuota
            ? `${formatFileSize(used)} / ${formatFileSize(limit)}`
            : formatFileSize(used)}
        </span>
      </div>

      {hasQuota && (
        <div className="bg-muted rounded-full h-3 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${
              ratio > 0.9 ? "bg-destructive" : ratio > 0.7 ? "bg-orange-500" : "bg-primary"
            }`}
            style={{ width: `${Math.min(100, ratio * 100)}%` }}
          />
        </div>
      )}

      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {hasQuota ? `${Math.round(ratio * 100)}% used` : "No storage limit set"}
        </p>
        {uploads.length > 0 && (
          <button
            onClick={() => setExpanded((o) => !o)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          >
            {expanded ? "Hide" : "Manage"} {uploads.length} file{uploads.length !== 1 ? "s" : ""}
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-180" : ""}`} />
          </button>
        )}
      </div>

      {expanded && (
        <div className="pt-1 space-y-1 max-h-72 overflow-y-auto">
          <p className="text-3xs text-muted-foreground uppercase tracking-wide">
            Largest first
          </p>
          {largest.map((file) => (
            <div
              key={file.url}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent/50 transition-colors"
            >
              <a
                href={file.url}
                target="_blank"
                rel="noreferrer"
                className="text-sm truncate flex-1 min-w-0 hover:underline"
                title={file.filename}
              >
                {file.filename}
              </a>
              <span className="text-xs text-muted-foreground shrink-0 tabular-nums">
                {formatFileSize(file.size)}
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive shrink-0"
                title={`Delete ${file.filename}`}
                disabled={deleting === file.url}
                onClick={() => handleDelete(file)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
