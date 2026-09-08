/**
 * Appearance settings that are not colours: text size, corner radius, row
 * density, and whether the interface moves.
 *
 * All four are applied to `<html>` — two as inline custom properties, two as
 * attributes the stylesheet keys off — so nothing has to thread them through
 * the component tree, and the pre-paint script in `index.html` can put them on
 * before React loads by replaying the same four assignments.
 */

export type Density = "comfortable" | "compact";
/** "system" defers to `prefers-reduced-motion`; the other two override it. */
export type MotionPreference = "system" | "reduce" | "full";

export interface DisplaySettings {
  /** Multiplier on the 17.6px root size everything else is sized in rem from. */
  fontScale: number;
  /** Corner radius in rem. Themes do not set `--radius`, so this is the only
   *  thing that decides it. */
  radius: number;
  density: Density;
  motion: MotionPreference;
}

export const DISPLAY_STORAGE_KEY = "chatter_display";

export const DEFAULT_DISPLAY: DisplaySettings = {
  fontScale: 1,
  radius: 0.875,
  density: "comfortable",
  motion: "system",
};

export const FONT_SCALE_RANGE = { min: 0.8, max: 1.4, step: 0.05 } as const;
export const RADIUS_RANGE = { min: 0, max: 1.5, step: 0.125 } as const;

const clamp = (v: number, min: number, max: number) =>
  Math.min(max, Math.max(min, v));

/** Coerce anything read back from storage into settings that render. A field
 *  that is missing or nonsense falls back rather than failing the whole set —
 *  a bad radius should not cost someone their text size. */
export function normalizeDisplay(raw: unknown): DisplaySettings {
  if (!raw || typeof raw !== "object") return DEFAULT_DISPLAY;
  const d = raw as Record<string, unknown>;
  return {
    fontScale:
      typeof d.fontScale === "number" && Number.isFinite(d.fontScale)
        ? clamp(d.fontScale, FONT_SCALE_RANGE.min, FONT_SCALE_RANGE.max)
        : DEFAULT_DISPLAY.fontScale,
    radius:
      typeof d.radius === "number" && Number.isFinite(d.radius)
        ? clamp(d.radius, RADIUS_RANGE.min, RADIUS_RANGE.max)
        : DEFAULT_DISPLAY.radius,
    density: d.density === "compact" ? "compact" : "comfortable",
    motion:
      d.motion === "reduce" || d.motion === "full" ? d.motion : "system",
  };
}

export function loadDisplay(): DisplaySettings {
  try {
    const raw = localStorage.getItem(DISPLAY_STORAGE_KEY);
    return normalizeDisplay(raw ? JSON.parse(raw) : null);
  } catch {
    return DEFAULT_DISPLAY;
  }
}

export function saveDisplay(settings: DisplaySettings): DisplaySettings {
  try {
    localStorage.setItem(DISPLAY_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Applied now, forgotten on reload.
  }
  return settings;
}

/**
 * Put the settings on `<html>`.
 *
 * The defaults are written as *absences* — no attribute, no inline property —
 * rather than as their default values, so a stylesheet change to what
 * "comfortable" means still reaches everyone who never touched the setting.
 */
export function applyDisplaySettings(settings: DisplaySettings) {
  const html = document.documentElement;
  const style = html.style;

  if (settings.fontScale === DEFAULT_DISPLAY.fontScale) {
    style.removeProperty("--font-scale");
  } else {
    style.setProperty("--font-scale", String(settings.fontScale));
  }

  if (settings.radius === DEFAULT_DISPLAY.radius) {
    style.removeProperty("--radius");
  } else {
    style.setProperty("--radius", `${settings.radius}rem`);
  }

  if (settings.density === "comfortable") {
    html.removeAttribute("data-density");
  } else {
    html.setAttribute("data-density", settings.density);
  }

  if (settings.motion === "system") {
    html.removeAttribute("data-motion");
  } else {
    html.setAttribute("data-motion", settings.motion);
  }
}

/**
 * Whether motion should be suppressed right now.
 *
 * CSS handles what it can, but a `scrollTo({ behavior: "smooth" })` is a
 * scripted animation the stylesheet cannot reach — those callers ask here.
 */
export function prefersReducedMotion(): boolean {
  if (typeof document === "undefined") return false;
  const setting = document.documentElement.getAttribute("data-motion");
  if (setting === "reduce") return true;
  if (setting === "full") return false;
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** `behavior` for a scroll that should glide unless motion is suppressed. */
export function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? "auto" : "smooth";
}
