import { useEffect, useRef } from "react";
import { useAppState } from "@/lib/store";
import {
  useThemeSettings,
  isSafeThemeId,
  normalizeAdvanced,
  normalizeDisplay,
  DEFAULT_DISPLAY,
  type ThemeDefinition,
} from "@/lib/theme";
import { isHexColor } from "@/lib/color";
import {
  apiGetAppearance,
  apiSetAppearance,
  type AppearancePayload,
} from "@/lib/api";

/** Long enough that dragging a slider is one write, short enough that closing
 *  the tab straight after a click rarely beats it — and the flush below covers
 *  when it does. */
const PUSH_DEBOUNCE_MS = 600;

function toThemeDefinition(
  raw: NonNullable<AppearancePayload["custom_themes"]>[number],
): ThemeDefinition | null {
  const c = raw?.colors;
  if (!c || !isSafeThemeId(raw.id)) return null;
  const keys = ["background", "card", "accent", "primary"] as const;
  if (!keys.every((k) => isHexColor(c[k]))) return null;
  if (raw.mode !== "light" && raw.mode !== "dark") return null;
  return {
    id: raw.id,
    name: raw.name,
    mode: raw.mode,
    colors: {
      background: c.background,
      card: c.card,
      accent: c.accent,
      primary: c.primary,
    },
    advanced: normalizeAdvanced(raw.advanced),
  };
}

/**
 * Keeps appearance settings in step with the server, so a theme built on one
 * device is there on the next.
 *
 * Renders nothing and lives inside AppProvider because that is where the
 * session is; the theme itself is owned a level up, and applies with or
 * without a server.
 *
 * The ordering rule that matters: nothing is pushed until the first fetch has
 * answered. A device that pushed first would overwrite the account's real
 * settings with the defaults it started on.
 */
export function ThemeSync() {
  const { accessToken, userId } = useAppState();
  const { themeId, customThemes, display, adoptRemote } = useThemeSettings();

  const readyRef = useRef(false);
  /** The settings the server is known to hold, so an adopted set is not
   *  immediately sent back and an unchanged set is not sent at all. */
  const syncedRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<string | null>(null);

  const localJson = JSON.stringify({
    theme_id: themeId,
    custom_themes: customThemes.map((t) => ({
      id: t.id,
      name: t.name,
      mode: t.mode,
      colors: t.colors,
      // Omitted rather than sent as null, so the shape matches what comes back
      // and the change detection below does not see a difference that is not
      // one.
      ...(t.advanced ? { advanced: t.advanced } : {}),
    })),
    display: {
      font_scale: display.fontScale,
      radius: display.radius,
      density: display.density,
      motion: display.motion,
    },
  });

  // A different account (or a logout) starts over: what the previous session
  // had is not this one's.
  useEffect(() => {
    readyRef.current = false;
    syncedRef.current = null;
  }, [userId]);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;

    apiGetAppearance()
      .then((remote) => {
        if (cancelled) return;
        const hasRemote =
          remote.theme_id !== null ||
          remote.custom_themes !== null ||
          remote.display !== null;

        if (hasRemote) {
          adoptRemote({
            themeId: remote.theme_id,
            customThemes:
              remote.custom_themes
                ?.map(toThemeDefinition)
                .filter((t): t is ThemeDefinition => t !== null) ?? null,
            display: remote.display
              ? normalizeDisplay({
                  fontScale: remote.display.font_scale,
                  radius: remote.display.radius,
                  density: remote.display.density,
                  motion: remote.display.motion,
                })
              : null,
          });
          // Whatever we just adopted is by definition what the server holds.
          syncedRef.current = JSON.stringify({
            theme_id: remote.theme_id,
            custom_themes: remote.custom_themes ?? [],
            display: remote.display ?? {
              font_scale: DEFAULT_DISPLAY.fontScale,
              radius: DEFAULT_DISPLAY.radius,
              density: DEFAULT_DISPLAY.density,
              motion: DEFAULT_DISPLAY.motion,
            },
          });
        }
        readyRef.current = true;
      })
      .catch(() => {
        // An unreachable server is not a reason to lose the local theme, and
        // not a reason to start pushing into the dark either.
      });

    return () => {
      cancelled = true;
    };
  }, [accessToken, adoptRemote]);

  useEffect(() => {
    if (!accessToken || !readyRef.current) return;
    if (localJson === syncedRef.current) return;

    pendingRef.current = localJson;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      const body = pendingRef.current;
      if (!body) return;
      apiSetAppearance(JSON.parse(body))
        .then(() => {
          syncedRef.current = body;
        })
        .catch(() => {
          // Left unsynced on purpose: the next change retries, and a failed
          // save must not make the app forget what it is showing.
        });
    }, PUSH_DEBOUNCE_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [accessToken, localJson]);

  // A change made and then immediately hidden — closing the tab, switching
  // apps on a phone — would otherwise sit in the debounce and be lost.
  useEffect(() => {
    const flush = () => {
      if (document.visibilityState !== "hidden") return;
      const body = pendingRef.current;
      if (!body || body === syncedRef.current || !readyRef.current) return;
      if (timerRef.current) clearTimeout(timerRef.current);
      apiSetAppearance(JSON.parse(body))
        .then(() => {
          syncedRef.current = body;
        })
        .catch(() => {});
    };
    document.addEventListener("visibilitychange", flush);
    return () => document.removeEventListener("visibilitychange", flush);
  }, []);

  return null;
}
