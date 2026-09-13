/**
 * A person's own colour, shown to everyone who looks at them.
 *
 * Deliberately separate from `lib/theme/` — that one is the viewer's choice
 * about their own client and covers every surface. This one travels with the
 * person, is set by them, and reaches exactly two places: their profile modal
 * and their row in the member list. Both read the wash from here so a profile
 * looks the same in the list as it does opened up.
 */

export const PROFILE_FADE_DIRECTIONS = ["down", "up", "left", "right"] as const;

export type ProfileFadeDirection = (typeof PROFILE_FADE_DIRECTIONS)[number];

export interface ProfileTheme {
  /** `#rrggbb`, or empty for no colour at all. */
  color: string;
  /** How far the colour travels before it is gone: 0 is a flat wash, 100 fades across the whole surface. */
  fade: number;
  direction: ProfileFadeDirection;
}

export const DEFAULT_PROFILE_FADE = 70;

export const DEFAULT_PROFILE_THEME: ProfileTheme = {
  color: "",
  fade: DEFAULT_PROFILE_FADE,
  direction: "down",
};

/** How strongly the wash is laid over the surface underneath it. */
export const PROFILE_WASH_ALPHA = {
  /** The modal has room for the colour to be the thing you notice. */
  modal: 0.32,
  /** A member row sits beside dozens of others, so it only ever tints. */
  row: 0.2,
} as const;

const HEX = /^#[0-9a-fA-F]{6}$/;

export function isProfileColor(color: string | undefined): color is string {
  return !!color && HEX.test(color);
}

function isFadeDirection(value: string | undefined): value is ProfileFadeDirection {
  return !!value && (PROFILE_FADE_DIRECTIONS as readonly string[]).includes(value);
}

/**
 * The theme a presence record carries, with anything missing or malformed
 * replaced by the default. Presence arrives from the server, so this is the
 * client's own guard rather than a formality: the values reach a `style`.
 */
export function readProfileTheme(presence: {
  profileColor?: string;
  profileFade?: number;
  profileFadeDirection?: string;
} | undefined): ProfileTheme {
  if (!presence) return DEFAULT_PROFILE_THEME;
  const fade = presence.profileFade;
  return {
    color: isProfileColor(presence.profileColor) ? presence.profileColor : "",
    fade: typeof fade === "number" && Number.isFinite(fade)
      ? Math.min(100, Math.max(0, Math.round(fade)))
      : DEFAULT_PROFILE_FADE,
    direction: isFadeDirection(presence.profileFadeDirection)
      ? presence.profileFadeDirection
      : DEFAULT_PROFILE_THEME.direction,
  };
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
 * The wash as a `background-image`, or undefined when the person has set no
 * colour — the caller then leaves the surface exactly as it was.
 *
 * The colour holds for `100 - fade` percent and gives out over the rest, so
 * fade 0 is an even wash and fade 100 fades the whole way across. Both stops
 * are the same colour with the far one transparent, because fading to
 * `transparent` fades through it: in most browsers that is transparent
 * *black*, which greys the middle of the gradient.
 */
export function profileWash(theme: ProfileTheme, alpha: number): string | undefined {
  if (!isProfileColor(theme.color)) return undefined;
  const hold = Math.min(100, Math.max(0, 100 - theme.fade));
  return `linear-gradient(${GRADIENT_TO[theme.direction]}, ${rgba(theme.color, alpha)} 0%, ${rgba(theme.color, alpha)} ${hold}%, ${rgba(theme.color, 0)} 100%)`;
}
