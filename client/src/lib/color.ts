/**
 * Colour maths shared by the theme picker and the theme editor.
 *
 * Themes arrive two ways: the built-ins are hand-authored oklch blocks in
 * `index.css`, and a custom theme is four hex colours somebody picked. Anything
 * that has to treat the two alike — drawing a swatch, exporting a theme — puts
 * the value through `normalizeToHex` first, so the rest of the code only ever
 * sees `#rrggbb`.
 */

export type Rgb = [number, number, number];

const HEX_RE = /^#[0-9a-f]{6}$/i;

export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX_RE.test(value.trim());
}

export function hexToRgb(hex: string): Rgb {
  const h = hex.trim().replace("#", "");
  return [
    parseInt(h.substring(0, 2), 16),
    parseInt(h.substring(2, 4), 16),
    parseInt(h.substring(4, 6), 16),
  ];
}

export function rgbToHex(r: number, g: number, b: number): string {
  return (
    "#" +
    [r, g, b]
      .map((v) =>
        Math.round(Math.max(0, Math.min(255, v)))
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}

export function mixColors(hex1: string, hex2: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(hex1);
  const [r2, g2, b2] = hexToRgb(hex2);
  return rgbToHex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t);
}

let probeCtx: CanvasRenderingContext2D | null | undefined;

/**
 * Resolve any colour the browser can parse — `oklch(...)`, `rgb(...)`, a
 * keyword — to `#rrggbb`.
 *
 * A canvas is the only reliable converter here. `getComputedStyle` hands an
 * `oklch()` custom property straight back as authored rather than resolving it
 * to sRGB, and `<input type="color">` accepts nothing but hex, so a built-in
 * theme could not seed the editor without this step.
 *
 * Returns `fallback` where there is no canvas at all (jsdom under test) or the
 * value does not parse.
 */
export function normalizeToHex(css: string, fallback = "#000000"): string {
  const value = css.trim();
  if (!value) return fallback;
  if (HEX_RE.test(value)) return value.toLowerCase();

  if (probeCtx === undefined) {
    try {
      probeCtx = document
        .createElement("canvas")
        .getContext("2d", { willReadFrequently: true });
    } catch {
      probeCtx = null;
    }
  }
  if (!probeCtx) return fallback;

  try {
    // An unparseable assignment to fillStyle is ignored rather than throwing,
    // so the sentinel below is what distinguishes "black" from "not a colour".
    probeCtx.fillStyle = "#ff00ff";
    probeCtx.fillStyle = value;
    if (probeCtx.fillStyle === "#ff00ff" && value !== "#ff00ff") return fallback;
    probeCtx.fillRect(0, 0, 1, 1);
    const [r, g, b] = probeCtx.getImageData(0, 0, 1, 1).data;
    return rgbToHex(r, g, b);
  } catch {
    return fallback;
  }
}

/** Perceived lightness, 0 (black) to 1 (white) — sRGB relative luminance. */
export function relativeLuminance(hex: string): number {
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/**
 * Which base palette a theme belongs to, judged from its background.
 *
 * The threshold sits well below the midpoint because the base blocks it picks
 * between are `:root` and `.dark`: a mid-grey background reads far better
 * against the dark set's light foreground than the light set's near-black one.
 */
export function isDarkColor(hex: string): boolean {
  return relativeLuminance(hex) < 0.35;
}
