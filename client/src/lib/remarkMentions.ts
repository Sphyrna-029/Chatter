// Not after a word character, so an address like a@b is left alone.
const MENTION_RE = /(?<!\w)@(\w+)/g;

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: Record<string, unknown>;
}

/** Turn every `@name` in ordinary text into a node that renders as a
 *  `<span data-mention>`. Code is untouched because its text lives in
 *  `code`/`inlineCode` nodes rather than `text` ones, and links are skipped
 *  so a mention cannot nest inside one. */
export function remarkMentions() {
  const walk = (node: MdNode) => {
    if (!node.children || node.type === "link" || node.type === "linkReference") return;
    const next: MdNode[] = [];
    for (const child of node.children) {
      if (child.type !== "text" || !child.value?.includes("@")) {
        walk(child);
        next.push(child);
        continue;
      }
      const text = child.value;
      let last = 0;
      for (const m of text.matchAll(MENTION_RE)) {
        const at = m.index ?? 0;
        if (at > last) next.push({ type: "text", value: text.slice(last, at) });
        next.push({
          type: "mention",
          data: {
            hName: "span",
            hProperties: { dataMention: m[1] },
            hChildren: [{ type: "text", value: m[0] }],
          },
        });
        last = at + m[0].length;
      }
      if (last < text.length) next.push({ type: "text", value: text.slice(last) });
    }
    node.children = next;
  };
  return (tree: MdNode) => walk(tree);
}
