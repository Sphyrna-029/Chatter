/**
 * A person's own colours, shown to everyone who looks at them.
 *
 * Deliberately separate from `lib/theme/` — that one is the viewer's choice
 * about their own client and covers every surface. This one travels with the
 * person, is set by them, and reaches exactly two places: their profile modal
 * and their tab in the member list. Each is set on its own, because a card
 * with room for a gradient and a strip beside dozens of others rarely want
 * the same thing.
 */

export const PROFILE_FADE_DIRECTIONS = ["down", "up", "left", "right"] as const;

export type ProfileFadeDirection = (typeof PROFILE_FADE_DIRECTIONS)[number];

export const PROFILE_SURFACES = ["modal", "tab"] as const;

export type ProfileSurface = (typeof PROFILE_SURFACES)[number];

export interface ProfileSurfaceTheme {
  /** `#rrggbb`, or empty to leave the surface alone. */
  color: string;
  /** `#rrggbb` to fade into, or empty to fade out into nothing. */
  color2: string;
  /** How far the first colour travels before it starts turning into the second: 0 is a flat wash, 100 spreads the change over the whole surface. */
  fade: number;
  direction: ProfileFadeDirection;
}

export type ProfileTheme = Record<ProfileSurface, ProfileSurfaceTheme>;

export const DEFAULT_PROFILE_FADE = 70;

export const DEFAULT_SURFACE_THEME: ProfileSurfaceTheme = {
  color: "",
  color2: "",
  fade: DEFAULT_PROFILE_FADE,
  direction: "down",
};

export const DEFAULT_PROFILE_THEME: ProfileTheme = {
  modal: DEFAULT_SURFACE_THEME,
  tab: DEFAULT_SURFACE_THEME,
};

/** How strongly each surface's wash is laid over what is underneath it. */
export const PROFILE_WASH_ALPHA: Record<ProfileSurface, number> = {
  /** The modal has room for the colour to be the thing you notice. */
  modal: 0.32,
  /** A tab sits beside dozens of others, so it only ever tints. */
  tab: 0.2,
};

const HEX = /^#[0-9a-fA-F]{6}$/;

export function isProfileColor(color: string | undefined): color is string {
  return !!color && HEX.test(color);
}

function isFadeDirection(value: unknown): value is ProfileFadeDirection {
  return typeof value === "string" && (PROFILE_FADE_DIRECTIONS as readonly string[]).includes(value);
}

function readSurface(raw: unknown): ProfileSurfaceTheme {
  const o = (raw ?? {}) as Partial<ProfileSurfaceTheme>;
  return {
    color: isProfileColor(o.color) ? o.color : "",
    color2: isProfileColor(o.color2) ? o.color2 : "",
    fade: typeof o.fade === "number" && Number.isFinite(o.fade)
      ? Math.min(100, Math.max(0, Math.round(o.fade)))
      : DEFAULT_PROFILE_FADE,
    direction: isFadeDirection(o.direction) ? o.direction : DEFAULT_SURFACE_THEME.direction,
  };
}

/**
 * The theme a presence record carries, with anything missing or malformed
 * replaced by the default. Presence arrives from the server, so this is the
 * client's own guard rather than a formality: the values reach a `style`.
 */
export function readProfileTheme(presence: { profileTheme?: unknown } | undefined): ProfileTheme {
  const raw = (presence?.profileTheme ?? {}) as Record<string, unknown>;
  return { modal: readSurface(raw.modal), tab: readSurface(raw.tab) };
}

function rgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const GRADIENT_TO: Record<ProfileFadeDirection, string> = {
  down: "to bottom",
  up: "to top",
  right: "to right",
  left: "to left",
};

/**
 * One surface's wash as a `background-image`, or undefined when no colour is
 * set — the caller then leaves the surface exactly as it was.
 *
 * The first colour holds for `100 - fade` percent and turns into the second
 * over the rest, so fade 0 is an even wash of the first colour and fade 100
 * spreads the change across the whole surface. With no second colour it fades
 * into the *same* colour at zero alpha rather than into `transparent`, which
 * is transparent black and greys the middle of the gradient.
 */
export function profileWash(theme: ProfileSurfaceTheme, alpha: number): string | undefined {
  if (!isProfileColor(theme.color)) return undefined;
  const from = rgba(theme.color, alpha);
  const to = isProfileColor(theme.color2) ? rgba(theme.color2, alpha) : rgba(theme.color, 0);
  const hold = Math.min(100, Math.max(0, 100 - theme.fade));
  return `linear-gradient(${GRADIENT_TO[theme.direction]}, ${from} 0%, ${from} ${hold}%, ${to} 100%)`;
}

/**
 * The one colour that stands for this person elsewhere in the app — the ring
 * while they speak, their dot in the typing indicator, the tint under their
 * messages on hover.
 *
 * Derived rather than set: a fourth control for "and your colour everywhere"
 * would be a fourth thing to keep in step with the other three. The member
 * list tab wins because that is already the person's marker in a list beside
 * everyone else; the card is the fallback for someone who only painted that.
 */
export function profileAccent(theme: ProfileTheme): string | undefined {
  return theme.tab.color || theme.modal.color || undefined;
}

/** The accent straight from a presence record, for callers that hold one. */
export function readProfileAccent(presence: { profileTheme?: unknown } | undefined): string | undefined {
  return profileAccent(readProfileTheme(presence));
}

/**
 * What "this person is speaking" looks like when the person has a colour.
 *
 * The glow's *presence* is the signal, not its hue, so swapping the uniform
 * green for the speaker's own colour costs nothing to read and says who is
 * talking before you get to the name. `geometry` is the box-shadow spread the
 * call site already used; only the colour comes from here.
 */
export function speakingStyle(
  accent: string | undefined,
  geometry: string,
): { boxShadow: string; color: string; backgroundColor?: string } | undefined {
  if (!isProfileColor(accent)) return undefined;
  return {
    boxShadow: `${geometry} ${accent}`,
    color: accent,
    backgroundColor: rgba(accent, 0.1),
  };
}

/** The wash for a surface, ready to spread into a `style` prop. */
export function profileWashStyle(
  theme: ProfileTheme,
  surface: ProfileSurface,
): { backgroundImage: string } | undefined {
  const wash = profileWash(theme[surface], PROFILE_WASH_ALPHA[surface]);
  return wash ? { backgroundImage: wash } : undefined;
}
