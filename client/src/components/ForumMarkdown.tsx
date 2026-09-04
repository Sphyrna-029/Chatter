import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import { AuthImage } from "@/components/AuthImage";
import remarkGfm from "remark-gfm";
import hljs from "highlight.js";

function CodeBlock({ code, language }: { code: string; language?: string }) {
  const [copied, setCopied] = useState(false);

  const highlighted = useMemo(() => {
    if (language && hljs.getLanguage(language)) {
      return hljs.highlight(code, { language }).value;
    }
    return hljs.highlightAuto(code).value;
  }, [code, language]);

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

interface ForumMarkdownProps {
  content: string;
  className?: string;
}

export function ForumMarkdown({ content, className }: ForumMarkdownProps) {
  return (
    <div className={`max-w-none break-words ${className ?? ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        children={content}
        components={{
          code({ className: codeClassName, children, ...props }) {
            const match = /language-(\w+)/.exec(codeClassName || "");
            const codeString = String(children).replace(/\n$/, "");
            if (match) {
              return <CodeBlock code={codeString} language={match[1]} />;
            }
            // Inline code
            return (
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono" {...props}>
                {children}
              </code>
            );
          },
          pre({ children }) {
            return <>{children}</>;
          },
          p({ children }) {
            return <p className="my-1.5 leading-relaxed">{children}</p>;
          },
          h1({ children }) {
            return <h1 className="text-lg font-bold mt-4 mb-2">{children}</h1>;
          },
          h2({ children }) {
            return <h2 className="text-base font-bold mt-3 mb-1.5">{children}</h2>;
          },
          h3({ children }) {
            return <h3 className="text-sm font-bold mt-2 mb-1">{children}</h3>;
          },
          a({ href, children }) {
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                {children}
              </a>
            );
          },
          img({ src, alt }) {
            return (
              <AuthImage
                src={src ?? ""}
                alt={alt || ""}
                className="max-w-full max-h-96 rounded-md object-contain my-2"
              />
            );
          },
          ul({ children }) {
            return <ul className="list-disc pl-5 my-1.5 space-y-0.5">{children}</ul>;
          },
          ol({ children }) {
            return <ol className="list-decimal pl-5 my-1.5 space-y-0.5">{children}</ol>;
          },
          li({ children }) {
            return <li className="leading-relaxed">{children}</li>;
          },
          strong({ children }) {
            return <strong className="font-bold">{children}</strong>;
          },
          em({ children }) {
            return <em className="italic">{children}</em>;
          },
          del({ children }) {
            return <del className="line-through text-muted-foreground">{children}</del>;
          },
          hr() {
            return <hr className="border-border my-3" />;
          },
          blockquote({ children }) {
            return (
              <blockquote className="border-l-2 border-primary/50 pl-3 my-2 text-muted-foreground italic">
                {children}
              </blockquote>
            );
          },
          table({ children }) {
            return (
              <div className="overflow-x-auto my-2">
                <table className="border-collapse border border-border text-sm w-full">
                  {children}
                </table>
              </div>
            );
          },
          thead({ children }) {
            return <thead className="bg-muted">{children}</thead>;
          },
          th({ children }) {
            return (
              <th className="border border-border px-3 py-1.5 text-left font-medium">
                {children}
              </th>
            );
          },
          td({ children }) {
            return (
              <td className="border border-border px-3 py-1.5">
                {children}
              </td>
            );
          },
          input({ checked, ...props }) {
            // GFM task list checkboxes
            return (
              <input
                type="checkbox"
                checked={checked}
                readOnly
                className="mr-1.5 align-middle"
                {...props}
              />
            );
          },
        }}
      />
    </div>
  );
}
