/**
 * Reading and writing the message composer.
 *
 * The composer is a contenteditable div rather than a textarea, because custom
 * emoji have to render as images inline while being typed. That means its
 * value is a DOM tree, and the message it represents is a string — these two
 * functions are the conversion, and they are inverses of each other.
 *
 * The string form is what gets sent, what the server stores, and what a saved
 * draft holds, so a draft written on one device and restored on another has to
 * survive the round trip exactly. That is what the tests here pin down.
 */

/** A custom emoji in the string form: the URL it renders from. */
const EMOJI_MARKER = /:emoji\{([^}]+)\}:/g;

/** Class applied to inline emoji images, matched to the composer's type size. */
const EMOJI_CLASS = "inline-block h-5 w-5 object-contain align-middle mx-0.5";

/** Build the inline image for one custom emoji. */
export function emojiImage(url: string): HTMLImageElement {
  const img = document.createElement("img");
  img.src = url;
  img.dataset.emojiUrl = url;
  // The alt is the marker itself, so copying out of the composer, or any
  // accessibility tool reading it, yields the text the message will carry.
  img.alt = `:emoji{${url}}:`;
  img.className = EMOJI_CLASS;
  return img;
}

/** The composer's contents as the string a message would be sent as. */
export function getComposerText(div: HTMLElement | null): string {
  if (!div) return "";
  const walk = (node: Node): string => {
    let result = "";
    node.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        result += child.textContent ?? "";
      } else if ((child as Element).tagName === "IMG") {
        const url = (child as HTMLImageElement).dataset.emojiUrl ?? "";
        result += `:emoji{${url}}:`;
      } else if ((child as Element).tagName === "BR") {
        result += "\n";
      } else {
        const tag = (child as Element).tagName;
        result += walk(child);
        if (tag === "DIV" || tag === "P") result += "\n";
      }
    });
    return result;
  };
  // Browsers leave a trailing block element behind after editing; the message
  // should not gain blank lines from that.
  return walk(div).replace(/\n+$/, "");
}

/** Replace the composer's contents with the DOM form of `text`. */
export function setComposerText(div: HTMLElement | null, text: string): void {
  if (!div) return;
  div.innerHTML = "";
  if (!text) return;

  const appendText = (chunk: string) => {
    chunk.split("\n").forEach((line, i) => {
      if (i > 0) div.appendChild(document.createElement("br"));
      if (line) div.appendChild(document.createTextNode(line));
    });
  };

  EMOJI_MARKER.lastIndex = 0;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = EMOJI_MARKER.exec(text)) !== null) {
    if (match.index > cursor) appendText(text.slice(cursor, match.index));
    div.appendChild(emojiImage(match[1]));
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) appendText(text.slice(cursor));
}

/**
 * Visible length, counting each custom emoji as one character.
 *
 * Used against the message length limit, where an emoji costing its whole URL
 * would make the counter disagree with what the user can see.
 */
export function composerLength(div: HTMLElement | null): number {
  if (!div) return 0;
  let len = 0;
  const walk = (node: Node) => {
    node.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        len += (child.textContent ?? "").length;
      } else if ((child as Element).tagName === "IMG") {
        len += 1;
      } else if ((child as Element).tagName === "BR") {
        len += 1;
      } else {
        walk(child);
        const tag = (child as Element).tagName;
        if (tag === "DIV" || tag === "P") len += 1;
      }
    });
  };
  walk(div);
  return len;
}
