/**
 * Everything about a theme that is not React: the built-in list, how a theme's
 * colours are resolved, and how one is read in or written out.
 *
 * Split from the provider the way `lib/store` is — a file that exports both a
 * component and the constants around it cannot hot-reload either.
 */
import {
  hexToRgb,
  isDarkColor,
  isHexColor,
  mixColors,
  normalizeToHex,
} from "@/lib/color";
import type { DisplaySettings } from "./display";

export type ThemeMode = "light" | "dark";

export interface ThemeColors {
  background: string;
  card: string;
  accent: string;
  primary: string;
}

export interface ThemeDefinition {
  id: string;
  name: string;
  /** Which base palette the theme sits on — `:root` or `.dark`. It decides the
   *  colours a theme does not name for itself: destructive, success, warning
   *  and info all come from the base block. */
  mode: ThemeMode;
  /** A custom theme carries the four colours it was built from. A built-in
   *  carries `null`: its colours are the oklch block in `index.css`, which is
   *  the single place they are written down. `resolveThemeColors` reads them
   *  back from there rather than keeping a second, drifting copy here. */
  colors: ThemeColors | null;
}

export const DEFAULT_THEME_ID = "dark";

/** Not a theme — a standing instruction to follow the OS. It resolves to the
 *  `light` or `dark` built-in and re-resolves when the OS flips, so it is kept
 *  out of `THEMES` and handled where the active theme is chosen. */
export const SYSTEM_THEME_ID = "system";

export const THEMES: ThemeDefinition[] = [
  { id: "light", name: "Light", mode: "light", colors: null },
  { id: "dark", name: "Default Dark", mode: "dark", colors: null },
  { id: "midnight", name: "Midnight", mode: "dark", colors: null },
  { id: "forest", name: "Forest", mode: "dark", colors: null },
  { id: "rose", name: "Rose", mode: "dark", colors: null },
  { id: "discord", name: "Discord", mode: "dark", colors: null },
  { id: "cotton-candy", name: "Cotton Candy", mode: "dark", colors: null },
  { id: "neon", name: "Neon", mode: "dark", colors: null },
];

export const STORAGE_KEY = "chatter_theme";
const CUSTOM_THEMES_KEY = "chatter_custom_themes";
/** What `index.html` replays before React loads. See `writePaintCache`. */
const PAINT_KEY = "chatter_theme_paint";

/** Used where the document cannot be read — under test, or before first
 *  paint. These are the Default Dark values. */
const FALLBACK_COLORS: ThemeColors = {
  background: "#262626",
  card: "#363636",
  accent: "#5f5f5f",
  primary: "#e8e8e8",
};

const builtInColors = new Map<string, ThemeColors>();

/**
 * Read a built-in theme's four headline colours out of the stylesheet.
 *
 * The probe carries `data-theme` for every theme including light and dark —
 * `index.css` aliases the two base blocks to that attribute for exactly this
 * reason. Matching a rule on the probe itself is what stops it inheriting the
 * currently applied theme's variables down from `<html>`.
 */
function readThemeColorsFromCss(theme: ThemeDefinition): ThemeColors {
  if (typeof document === "undefined" || !document.body) return FALLBACK_COLORS;

  const probe = document.createElement("div");
  probe.style.cssText =
    "position:absolute;width:0;height:0;visibility:hidden;pointer-events:none";
  if (theme.mode === "dark") probe.className = "dark";
  probe.dataset.theme = theme.id;
  document.body.appendChild(probe);

  try {
    const computed = getComputedStyle(probe);
    const read = (name: keyof ThemeColors) =>
      normalizeToHex(
        computed.getPropertyValue(`--${name}`),
        FALLBACK_COLORS[name],
      );
    return {
      background: read("background"),
      card: read("card"),
      accent: read("accent"),
      primary: read("primary"),
    };
  } finally {
    probe.remove();
  }
}

/** The four colours a theme is previewed and exported by, wherever it came
 *  from. Built-in results are cached — the stylesheet does not change. */
export function resolveThemeColors(theme: ThemeDefinition): ThemeColors {
  if (theme.colors) return theme.colors;
  const cached = builtInColors.get(theme.id);
  if (cached) return cached;
  const colors = readThemeColorsFromCss(theme);
  builtInColors.set(theme.id, colors);
  return colors;
}

export function deriveThemeVars(colors: ThemeColors): Record<string, string> {
  const { background, card, accent, primary } = colors;
  const [ar, ag, ab] = hexToRgb(accent);
  const secondary = mixColors(background, card, 0.5);
  const mutedFg = mixColors(background, primary, 0.55);

  // Deliberately absent: destructive, success, warning and info. Those are not
  // derivable from four colours — red has to stay red — and pinning them here
  // is what used to give a pale custom theme the dark palette's status
  // colours. Left unset they fall through to the base block the theme's mode
  // selects, which has a tuned pair for each.
  return {
    "--background": background,
    "--foreground": primary,
    "--card": card,
    "--card-foreground": primary,
    "--popover": mixColors(card, background, 0.2),
    "--popover-foreground": primary,
    "--primary": primary,
    "--primary-foreground": background,
    "--secondary": secondary,
    "--secondary-foreground": primary,
    "--muted": secondary,
    "--muted-foreground": mutedFg,
    "--accent": accent,
    "--accent-foreground": primary,
    "--border": `rgba(${ar}, ${ag}, ${ab}, 0.3)`,
    "--input": `rgba(${ar}, ${ag}, ${ab}, 0.35)`,
    "--ring": accent,
    "--chart-1": accent,
    "--chart-2": mixColors(accent, primary, 0.3),
    "--chart-3": primary,
    "--chart-4": mixColors(accent, primary, 0.6),
    "--chart-5": mixColors(accent, background, 0.3),
    "--sidebar": mixColors(background, card, 0.3),
    "--sidebar-foreground": primary,
    "--sidebar-primary": accent,
    "--sidebar-primary-foreground": primary,
    "--sidebar-accent": secondary,
    "--sidebar-accent-foreground": primary,
    "--sidebar-border": `rgba(${ar}, ${ag}, ${ab}, 0.3)`,
    "--sidebar-ring": accent,
  };
}

/** The rule a custom theme is applied through, as text.
 *
 *  `html[...]` rather than a bare attribute selector: the base blocks are class
 *  and attribute rules of equal weight, and relying on this sheet being the
 *  last one in the head loses the tie whenever HMR re-injects index.css. */
export function customThemeCss(theme: ThemeDefinition): string {
  if (!theme.colors) return "";
  const body = Object.entries(deriveThemeVars(theme.colors))
    .map(([k, v]) => `${k}: ${v};`)
    .join("\n  ");
  return `html[data-theme="${theme.id}"] {\n  ${body}\n}`;
}

export function setCustomThemeStyle(css: string) {
  let el = document.getElementById(
    "custom-theme-style",
  ) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = "custom-theme-style";
    document.head.appendChild(el);
  }
  el.textContent = css;
}

export function removeCustomThemeStyle() {
  document.getElementById("custom-theme-style")?.remove();
}

/**
 * Leave behind everything the pre-paint script in `index.html` needs to put the
 * theme on screen before React has loaded.
 *
 * It is a cache rather than a second implementation: the script replays this
 * verbatim and derives nothing, so the rules for what a theme looks like stay
 * in one place. A miss — a first visit, a theme changed in another tab — costs
 * one frame of the wrong palette, not a wrong theme.
 */
export function writePaintCache(theme: ThemeDefinition, css: string, bg: string) {
  try {
    localStorage.setItem(
      PAINT_KEY,
      JSON.stringify({ id: theme.id, mode: theme.mode, css, bg }),
    );
  } catch {
    // Storage full or blocked; the app still themes itself a frame later.
  }
}

export function newThemeId(): string {
  return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Themes stored before modes existed have no `mode`, and were all rendered
 *  dark whatever their colours. Reading one back infers the mode its colours
 *  actually call for. */
function normalizeStoredTheme(raw: unknown): ThemeDefinition | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  const colors = t.colors as Record<string, unknown> | undefined;
  if (!colors) return null;
  const keys = ["background", "card", "accent", "primary"] as const;
  if (!keys.every((k) => isHexColor(colors[k]))) return null;

  const resolved = Object.fromEntries(
    keys.map((k) => [k, (colors[k] as string).toLowerCase()]),
  ) as unknown as ThemeColors;

  return {
    id: typeof t.id === "string" ? t.id : newThemeId(),
    name: typeof t.name === "string" ? t.name : "Custom",
    mode:
      t.mode === "light" || t.mode === "dark"
        ? t.mode
        : isDarkColor(resolved.background)
          ? "dark"
          : "light",
    colors: resolved,
  };
}

/** Write the custom theme list back, returning it so callers can use this
 *  inside a state updater. A full or blocked store costs the user the theme on
 *  the next load, which is not worth failing the edit they just made. */
export function persistCustomThemes(next: ThemeDefinition[]): ThemeDefinition[] {
  try {
    localStorage.setItem(CUSTOM_THEMES_KEY, JSON.stringify(next));
  } catch {
    // Applied now, forgotten on reload.
  }
  return next;
}

export function loadCustomThemes(): ThemeDefinition[] {
  try {
    const raw = localStorage.getItem(CUSTOM_THEMES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeStoredTheme)
      .filter((t): t is ThemeDefinition => t !== null);
  } catch {
    return [];
  }
}

/** Read one colour out of imported JSON, accepting anything CSS can parse and
 *  storing hex — the editor's colour inputs take nothing else. */
function parseColorField(data: Record<string, unknown>, key: string): string {
  const raw = data[key];
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error(`Theme is missing "${key}"`);
  }
  const hex = normalizeToHex(raw, "");
  if (!hex) throw new Error(`"${key}" is not a colour: ${raw}`);
  return hex;
}

/** Parse an exported theme. Exported alongside `mode`, but older exports and
 *  hand-written JSON carry only colours, so the mode stays optional. */
export function parseImportedTheme(json: string): ThemeDefinition {
  const data = JSON.parse(json) as Record<string, unknown>;
  if (typeof data.name !== "string" || !data.name.trim()) {
    throw new Error("Theme is missing \"name\"");
  }
  const colors: ThemeColors = {
    background: parseColorField(data, "background"),
    card: parseColorField(data, "card"),
    accent: parseColorField(data, "accent"),
    primary: parseColorField(data, "primary"),
  };
  return {
    id: newThemeId(),
    name: data.name.trim(),
    mode:
      data.mode === "light" || data.mode === "dark"
        ? data.mode
        : isDarkColor(colors.background)
          ? "dark"
          : "light",
    colors,
  };
}

/** `useSyncExternalStore` subscriber for the OS colour-scheme preference. */
export function subscribePrefersDark(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

export function getPrefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

export interface ThemeSettings {
  /** Appearance that is not colour — text size, radius, density, motion. */
  display: DisplaySettings;
  /** Merge a change into the display settings. */
  setDisplay: (patch: Partial<DisplaySettings>) => void;
  resetDisplay: () => void;
  /** What the user picked — a theme id, or `SYSTEM_THEME_ID`. */
  themeId: string;
  /** The theme actually in force, resolved past `system` and past a stale or
   *  deleted id. */
  activeTheme: ThemeDefinition;
  /** The built-in `system` currently resolves to, whatever is selected. */
  systemTheme: ThemeDefinition;
  themes: ThemeDefinition[];
  customThemes: ThemeDefinition[];
  setTheme: (id: string) => void;
  addCustomTheme: (
    name: string,
    colors: ThemeColors,
    mode?: ThemeMode,
  ) => ThemeDefinition;
  updateCustomTheme: (
    id: string,
    name: string,
    colors: ThemeColors,
    mode?: ThemeMode,
  ) => void;
  deleteCustomTheme: (id: string) => void;
  exportTheme: (id: string) => string | null;
  importTheme: (json: string) => ThemeDefinition;
}
