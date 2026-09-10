const registeredFonts = new Set<string>();

/**
 * Whether a stored font URL is safe to write into a stylesheet.
 *
 * The server validates this on the way in (`valid_name_font_url`), but the
 * value arrives here from the network and lands in CSS, which is the sink that
 * actually matters: a URL that closes the `url('…')` string is not a broken
 * font, it is arbitrary CSS running in every viewer's page. Records written
 * before the server checked are still in the database, so the check is worth
 * repeating rather than assuming.
 *
 * Same rule as the server: same-origin, under `/external/`, and free of the
 * characters that end a CSS string or a rule.
 */
function isSafeFontUrl(url: string): boolean {
  if (!url || url.length > 512) return false;
  if (/["'\\()<>{};]|\s/.test(url)) return false;
  const path = /^https?:\/\//i.test(url) ? url.slice(url.indexOf("/", 8)) : url;
  return path.startsWith("/external/") && !path.includes("..");
}

export function ensureFontFace(userId: string, url: string) {
  if (!isSafeFontUrl(url)) return;
  const key = `${userId}:${url}`;
  if (registeredFonts.has(key)) return;
  registeredFonts.add(key);
  const style = document.createElement("style");
  style.textContent = `@font-face { font-family: 'user-font-${CSS.escape(userId)}'; src: url('${url}'); }`;
  document.head.appendChild(style);
}
