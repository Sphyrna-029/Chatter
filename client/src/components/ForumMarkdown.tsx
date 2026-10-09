import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import { AuthImage } from "@/components/AuthImage";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./CodeBlock";
import { useAppContext } from "@/lib/store";
import { mentionRoleColors } from "@/lib/mentions";
import { remarkMentions } from "@/lib/remarkMentions";
import { cn, displayUserId } from "@/lib/utils";

interface ForumMarkdownProps {
  content: string;
  className?: string;
}

export function ForumMarkdown({ content, className }: ForumMarkdownProps) {
  const { state } = useAppContext();
  const roomInfo = state.currentRoomId ? state.roomInfoMap[state.currentRoomId] : null;
  const roleColors = useMemo(
    () => mentionRoleColors(state.customRoles, roomInfo),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.customRoles, roomInfo?.owner_name_color, roomInfo?.mod_name_color],
  );
  const myName = state.userId ? displayUserId(state.userId).toLowerCase() : "";

  return (
    <div className={`max-w-none break-words ${className ?? ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMentions]}
        children={content}
        components={{
          span(props) {
            const { children } = props;
            // Raw HTML is not enabled, so the only spans are remarkMentions'.
            const name = (props as Record<string, unknown>)["data-mention"];
            if (typeof name !== "string") return <span>{children}</span>;
            // Drawn the way the timeline draws them (MessageItem).
            const roleColor = roleColors.get(name.toLowerCase());
            if (roleColor !== undefined) {
              const safeColor = /^#?[a-zA-Z0-9]+$/.test(roleColor) ? roleColor : "";
              return (
                <span
                  className={cn(
                    "rounded px-1 py-0.5 font-semibold text-xs",
                    !safeColor && "bg-primary/20 text-primary",
                  )}
                  style={safeColor ? { backgroundColor: `${safeColor}33`, color: safeColor } : undefined}
                >
                  {children}
                </span>
              );
            }
            return (
              <span
                className={cn(
                  "rounded px-1 py-0.5 font-semibold text-xs",
                  name.toLowerCase() === myName ? "bg-blue-500/20 text-blue-400" : "bg-primary/20 text-primary",
                )}
              >
                {children}
              </span>
            );
          },
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
