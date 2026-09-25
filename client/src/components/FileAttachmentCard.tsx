import { useEffect, useState } from "react";
import { FileText, FileArchive, FileCode, FileSpreadsheet, File as FileIcon } from "lucide-react";
import { useAppContext } from "@/lib/store";

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * An uploaded file that is not drawn inline — an archive, a document, a
 * program — as a download with its name, kind and size. Shared by the chat
 * timeline and the forum so a file looks the same wherever it was posted.
 */
export function FileAttachmentCard({ url }: { url: string }) {
  const { state } = useAppContext();
  // Extract filename from URL: /external/{folder}/{encoded_filename}
  const segments = url.split("/");
  const rawName = decodeURIComponent(segments[segments.length - 1] || "file");
  // Strip query params
  const fileName = rawName.split("?")[0];
  const dotIdx = fileName.lastIndexOf(".");
  const ext = dotIdx > 0 ? fileName.slice(dotIdx + 1).toUpperCase() : "";
  const baseName = dotIdx > 0 ? fileName.slice(0, dotIdx) : fileName;

  const [fileSize, setFileSize] = useState<number | null>(null);

  useEffect(() => {
    // The Authorization header is not needed here because the media_session
    // HttpOnly cookie is sent automatically by the browser.
    fetch(url, { method: "HEAD" })
      .then((res) => {
        const len = res.headers.get("content-length");
        if (len) setFileSize(parseInt(len, 10));
      })
      .catch(() => {});
  }, [url, state.requireAuthForUploads]);

  const IconComponent = /^(zip|rar|7z|tar|gz|bz2)$/i.test(ext) ? FileArchive
    : /^(js|ts|tsx|jsx|py|rs|go|java|c|cpp|h|html|css|json|xml|yml|yaml|sh|sql|rb|php)$/i.test(ext) ? FileCode
    : /^(csv|xls|xlsx)$/i.test(ext) ? FileSpreadsheet
    : /^(txt|md|log|pdf|doc|docx|rtf)$/i.test(ext) ? FileText
    : FileIcon;

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      download={fileName}
      className="mt-1 flex items-center gap-3 rounded-md border border-border bg-secondary/30 hover:bg-secondary/50 transition-colors px-3 py-2.5 max-w-sm group"
    >
      <IconComponent className="h-8 w-8 text-muted-foreground shrink-0 group-hover:text-foreground transition-colors" />
      <div className="flex flex-col min-w-0">
        <span className="text-sm font-medium truncate">{baseName}</span>
        <span className="text-xs text-muted-foreground">
          {ext ? `${ext} file` : "File"}{fileSize !== null ? ` · ${formatFileSize(fileSize)}` : ""}
        </span>
      </div>
    </a>
  );
}
