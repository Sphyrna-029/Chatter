import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { isDarkColor } from "@/lib/color";
import { ThemeContext } from "./context";
import {
  applyDisplaySettings,
  loadDisplay,
  normalizeDisplay,
  saveDisplay,
  DEFAULT_DISPLAY,
  type DisplaySettings,
} from "./display";
import {
  customThemeCss,
  getPrefersDark,
  loadCustomThemes,
  newThemeId,
  parseImportedTheme,
  persistCustomThemes,
  removeCustomThemeStyle,
  resolveThemeColors,
  setCustomThemeStyle,
  subscribePrefersDark,
  writePaintCache,
  DEFAULT_THEME_ID,
  STORAGE_KEY,
  SYSTEM_THEME_ID,
  THEMES,
  type ThemeColors,
  type ThemeDefinition,
  type ThemeAdvanced,
  type ThemeMode,
  type ThemeSettings,
} from "./themes";

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [themeId, setThemeId] = useState<string>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) || DEFAULT_THEME_ID;
    } catch {
      return DEFAULT_THEME_ID;
    }
  });

  const [customThemes, setCustomThemes] =
    useState<ThemeDefinition[]>(loadCustomThemes);

  const [display, setDisplayState] = useState<DisplaySettings>(loadDisplay);

  useEffect(() => {
    applyDisplaySettings(display);
  }, [display]);

  const setDisplay = useCallback((patch: Partial<DisplaySettings>) => {
    setDisplayState((prev) => saveDisplay(normalizeDisplay({ ...prev, ...patch })));
  }, []);

  const resetDisplay = useCallback(() => {
    setDisplayState(saveDisplay(DEFAULT_DISPLAY));
  }, []);

  // Subscribed rather than mirrored into state: the OS can flip between the
  // first render and an effect, and a snapshot read has no window to miss it in.
  const prefersDark = useSyncExternalStore(
    subscribePrefersDark,
    getPrefersDark,
    () => false,
  );

  const themes = useMemo(
    () => [...THEMES, ...customThemes],
    [customThemes],
  );

  const systemTheme = useMemo(
    () => THEMES.find((t) => t.id === (prefersDark ? "dark" : "light"))!,
    [prefersDark],
  );

  const activeTheme = useMemo(() => {
    if (themeId === SYSTEM_THEME_ID) return systemTheme;
    return (
      themes.find((t) => t.id === themeId) ??
      THEMES.find((t) => t.id === DEFAULT_THEME_ID)!
    );
  }, [themes, themeId, systemTheme]);

  useEffect(() => {
    const html = document.documentElement;
    html.classList.toggle("dark", activeTheme.mode === "dark");

    let css = "";
    if (activeTheme.colors) {
      html.setAttribute("data-theme", activeTheme.id);
      css = customThemeCss(activeTheme);
      setCustomThemeStyle(css);
    } else {
      removeCustomThemeStyle();
      // The two base themes are the bare `:root` and `.dark` blocks; the rest
      // are attribute blocks layered over them.
      if (activeTheme.id === "light" || activeTheme.id === "dark") {
        html.removeAttribute("data-theme");
      } else {
        html.setAttribute("data-theme", activeTheme.id);
      }
    }

    // The browser paints its own chrome around a installed PWA from this, so a
    // themed app inside a #262626 frame is the tell that it is not set.
    const background = resolveThemeColors(activeTheme).background;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", background);

    writePaintCache(activeTheme, css, background);
  }, [activeTheme]);


  /**
   * Take settings that came from the server as the current ones.
   *
   * Separate from the setters so a sync can tell its own write apart from a
   * change the person in front of it made — adopting must not bounce straight
   * back up as an edit.
   */
  const adoptRemote = useCallback(
    (remote: {
      themeId: string | null;
      customThemes: ThemeDefinition[] | null;
      display: DisplaySettings | null;
    }) => {
      if (remote.customThemes) {
        setCustomThemes(persistCustomThemes(remote.customThemes));
      }
      if (remote.themeId) {
        setThemeId(remote.themeId);
        try {
          localStorage.setItem(STORAGE_KEY, remote.themeId);
        } catch {
          // Applied now, forgotten on reload.
        }
      }
      if (remote.display) setDisplayState(saveDisplay(remote.display));
    },
    [],
  );

  const setTheme = useCallback((id: string) => {
    setThemeId(id);
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // Same as above: applied now, forgotten on reload.
    }
  }, []);

  const addCustomTheme = useCallback(
    (
      name: string,
      colors: ThemeColors,
      mode?: ThemeMode,
      advanced?: ThemeAdvanced,
    ): ThemeDefinition => {
      const theme: ThemeDefinition = {
        id: newThemeId(),
        name,
        mode: mode ?? (isDarkColor(colors.background) ? "dark" : "light"),
        colors,
        advanced,
      };
      setCustomThemes((prev) => persistCustomThemes([...prev, theme]));
      return theme;
    },
    [],
  );

  const updateCustomTheme = useCallback(
    (
      id: string,
      name: string,
      colors: ThemeColors,
      mode?: ThemeMode,
      advanced?: ThemeAdvanced,
    ) => {
      setCustomThemes((prev) =>
        persistCustomThemes(
          prev.map((t) =>
            t.id === id
              ? {
                  ...t,
                  name,
                  colors,
                  advanced,
                  mode:
                    mode ?? (isDarkColor(colors.background) ? "dark" : "light"),
                }
              : t,
          ),
        ),
      );
    },
    [],
  );

  const deleteCustomTheme = useCallback(
    (id: string) => {
      setCustomThemes((prev) => persistCustomThemes(prev.filter((t) => t.id !== id)));
      setThemeId((prev) => {
        if (prev !== id) return prev;
        try {
          localStorage.setItem(STORAGE_KEY, DEFAULT_THEME_ID);
        } catch {
          // Applied now, forgotten on reload.
        }
        return DEFAULT_THEME_ID;
      });
    },
    [],
  );

  const exportTheme = useCallback(
    (id: string): string | null => {
      const theme = themes.find((t) => t.id === id);
      if (!theme) return null;
      const colors = resolveThemeColors(theme);
      return JSON.stringify(
        {
          name: theme.name,
          mode: theme.mode,
          ...colors,
          // Omitted entirely when a theme derives everything, so the common
          // export stays the four colours it always was.
          ...(theme.advanced ? { advanced: theme.advanced } : {}),
        },
        null,
        2,
      );
    },
    [themes],
  );

  const importTheme = useCallback(
    (json: string): ThemeDefinition => {
      const theme = parseImportedTheme(json);
      setCustomThemes((prev) => persistCustomThemes([...prev, theme]));
      return theme;
    },
    [],
  );

  const value = useMemo<ThemeSettings>(
    () => ({
      display,
      setDisplay,
      resetDisplay,
      adoptRemote,
      themeId,
      activeTheme,
      systemTheme,
      themes,
      customThemes,
      setTheme,
      addCustomTheme,
      updateCustomTheme,
      deleteCustomTheme,
      exportTheme,
      importTheme,
    }),
    [
      display,
      setDisplay,
      resetDisplay,
      adoptRemote,
      themeId,
      activeTheme,
      systemTheme,
      themes,
      customThemes,
      setTheme,
      addCustomTheme,
      updateCustomTheme,
      deleteCustomTheme,
      exportTheme,
      importTheme,
    ],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}
