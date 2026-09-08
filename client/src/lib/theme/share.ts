/**
 * Themes as something you can send someone.
 *
 * Exporting produced a block of JSON, which survives a paste into a chat
 * message poorly and a paste into a browser bar not at all. A share code is
 * the same theme as one token, and a share link is that token on a URL this
 * app opens and offers to add.
 *
 * The encoding is positional rather than an object: a theme is four colours,
 * a name and a mode, and spelling those keys out tripled the length of the
 * thing people have to paste. Colours drop their "#" for the same reason.
 */
import {
  isHexColor,
  isDarkColor,
  normalizeToHex,
} from "@/lib/color";
import {
  newThemeId,
  normalizeAdvanced,
  parseImportedTheme,
  type ThemeAdvanced,
  type ThemeDefinition,
} from "./themes";

/** Version prefix. A later format changes this rather than guessing, so an
 *  old client says "this is not a theme" instead of decoding one wrongly. */
const PREFIX = "ct1_";

/** The query parameter a share link carries. */
export const THEME_PARAM = "theme";

const MAX_CODE_LENGTH = 512;
const MAX_NAME_LENGTH = 60;

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(code: string): string {
  const padded = code.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** `#aabbcc` → `aabbcc`, because the hash costs three characters once encoded
 *  and carries no information. */
const strip = (hex: string) => hex.replace("#", "").toLowerCase();

export function encodeThemeShare(
  theme: Pick<ThemeDefinition, "name" | "mode"> & {
    colors: NonNullable<ThemeDefinition["colors"]>;
    advanced?: ThemeAdvanced;
  },
): string {
  const { colors, advanced } = theme;
  const payload: unknown[] = [
    theme.name,
    theme.mode,
    strip(colors.background),
    strip(colors.card),
    strip(colors.accent),
    strip(colors.primary),
  ];
  if (advanced) {
    payload.push([
      advanced.sidebar ? strip(advanced.sidebar) : null,
      advanced.mention ? strip(advanced.mention) : null,
      advanced.borderStrength ?? null,
    ]);
  }
  return PREFIX + toBase64Url(JSON.stringify(payload));
}

function hexField(value: unknown, field: string): string {
  const hex = typeof value === "string" ? `#${value.replace("#", "")}` : "";
  if (!isHexColor(hex)) throw new Error(`Share code has a bad ${field}`);
  return hex.toLowerCase();
}

export function decodeThemeShare(code: string): ThemeDefinition {
  const trimmed = code.trim();
  if (!trimmed.startsWith(PREFIX)) throw new Error("Not a theme share code");
  if (trimmed.length > MAX_CODE_LENGTH) throw new Error("Share code is too long");

  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64Url(trimmed.slice(PREFIX.length)));
  } catch {
    throw new Error("Share code is damaged — it may have been cut short");
  }
  if (!Array.isArray(parsed) || parsed.length < 6) {
    throw new Error("Share code is incomplete");
  }

  const [name, mode, background, card, accent, primary, advancedRaw] = parsed;
  if (typeof name !== "string" || !name.trim()) {
    throw new Error("Share code has no name");
  }

  const colors = {
    background: hexField(background, "background"),
    card: hexField(card, "card"),
    accent: hexField(accent, "accent"),
    primary: hexField(primary, "primary"),
  };

  let advanced: ThemeAdvanced | undefined;
  if (Array.isArray(advancedRaw)) {
    const [sidebar, mention, borderStrength] = advancedRaw;
    advanced = normalizeAdvanced({
      sidebar: typeof sidebar === "string" ? `#${sidebar}` : undefined,
      mention: typeof mention === "string" ? `#${mention}` : undefined,
      borderStrength: typeof borderStrength === "number" ? borderStrength : undefined,
    });
  }

  return {
    id: newThemeId(),
    name: name.trim().slice(0, MAX_NAME_LENGTH),
    mode:
      mode === "light" || mode === "dark"
        ? mode
        : isDarkColor(colors.background)
          ? "dark"
          : "light",
    colors,
    advanced,
  };
}

/** A link that opens this app with the theme ready to add. */
export function themeShareLink(code: string, origin?: string): string {
  const base =
    origin ?? (typeof window !== "undefined" ? window.location.origin : "");
  return `${base}/?${THEME_PARAM}=${code}`;
}

/** Pull a share code out of whatever was pasted: a link, a bare code, or a
 *  code with text around it — someone forwarding a chat message rarely trims
 *  it to the token. */
export function extractShareCode(input: string): string | null {
  const match = input.match(/ct1_[A-Za-z0-9_-]+/);
  return match ? match[0] : null;
}

/**
 * The one entry point for "the user pasted something and wants that theme".
 *
 * Accepts a share link, a share code, or the JSON that earlier versions
 * exported — old exports keep working, and someone hand-writing a theme still
 * can. Anything else raises the message that fits what they actually pasted.
 */
export function parseThemeInput(input: string): ThemeDefinition {
  const text = input.trim();
  if (!text) throw new Error("Nothing to import");

  const code = extractShareCode(text);
  if (code) return decodeThemeShare(code);

  if (text.startsWith("{")) return parseImportedTheme(text);

  if (text.startsWith("http") || text.startsWith("ct")) {
    throw new Error("That link or code does not contain a theme");
  }
  throw new Error("Paste a theme share code, a share link, or theme JSON");
}

/** Normalise a colour that came from outside before it is shared onward. */
export function shareableColor(value: string): string {
  return normalizeToHex(value, "#000000");
}
