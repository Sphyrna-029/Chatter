import { useMemo, useState } from "react";
import { highlightCode } from "@/lib/highlight";

/**
 * A fenced code block with syntax highlighting and a copy button.
 *
 * Shared by chat messages and forum posts, which had byte-identical copies of
 * this before. Keeping one means the highlighter is imported once, which is
 * what lets it stay out of the bundle twice over.
 */
export function CodeBlock({ code, language }: { code: string; language?: string }) {
  const [copied, setCopied] = useState(false);

  const highlighted = useMemo(() => highlightCode(code, language), [code, language]);

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative group/code my-1">
      <button
        onClick={handleCopy}
        className="absolute right-2 top-2 can-hover:opacity-0 can-hover:group-hover/code:opacity-100 transition-opacity text-xs px-2 py-1 rounded bg-secondary hover:bg-accent text-muted-foreground cursor-pointer"
      >
        {copied ? "Copied!" : "Copy"}
      </button>
      <pre className="rounded-md bg-[#0d1117] p-3 overflow-x-auto text-sm">
        <code
          className="hljs"
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
      </pre>
    </div>
  );
}
