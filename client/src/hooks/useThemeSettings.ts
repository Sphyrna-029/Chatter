import { useState, useEffect, useCallback } from "react";

export interface ThemeColors {
  background: string;
  card: string;
  accent: string;
  primary: string;
}

export interface ThemeDefinition {
  id: string;
  name: string;
  colors: ThemeColors;
}

export const THEMES: ThemeDefinition[] = [
  {
    id: "light",
    name: "Light",
    colors: {
      background: "#ffffff",
      card: "#f5f5f5",
      accent: "#f5f5f5",
      primary: "#1a1a1a",
    },
  },
  {
    id: "dark",
    name: "Default Dark",
    colors: {
      background: "#262626",
      card: "#363636",
      accent: "#5f5f5f",
      primary: "#e8e8e8",
    },
  },
  {
    id: "midnight",
    name: "Midnight",
    colors: {
      background: "#0f1729",
      card: "#162040",
      accent: "#2563eb",
      primary: "#93bbff",
    },
  },
  {
    id: "forest",
    name: "Forest",
    colors: {
      background: "#0f1a14",
      card: "#152e1e",
      accent: "#22c55e",
      primary: "#86efac",
    },
  },
  {
    id: "rose",
    name: "Rose",
    colors: {
      background: "#1a0f14",
      card: "#2e1525",
      accent: "#e11d48",
      primary: "#fda4af",
    },
  },
  {
    id: "discord",
    name: "Discord",
    colors: {
      background: "#313338",
      card: "#2b2d31",
      accent: "#5865f2",
      primary: "#f2f3f5",
    },
  },
  {
    id: "cotton-candy",
    name: "Cotton Candy",
    colors: {
      background: "#1a1025",
      card: "#251538",
      accent: "#e040fb",
      primary: "#67e8f9",
    },
  },
  {
    id: "neon",
    name: "Neon",
    colors: {
      background: "#0a0a0a",
      card: "#141414",
      accent: "#39ff14",
      primary: "#ff073a",
    },
  },
  {
    id: "marathon",
    name: "Marathon",
    colors: {
      background: "#0b0d13",
      card: "#161a24",
      accent: "#00e64d",
      primary: "#d0d4dc",
    },
  },
];

const STORAGE_KEY = "chatter_theme";
const CUSTOM_THEMES_KEY = "chatter_custom_themes";

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.substring(0, 2), 16),
    parseInt(h.substring(2, 4), 16),
    parseInt(h.substring(4, 6), 16),
  ];
}

function rgbToHex(r: number, g: number, b: number): string {
  return (
    "#" +
    [r, g, b]
      .map((v) =>
        Math.round(Math.max(0, Math.min(255, v)))
          .toString(16)
          .padStart(2, "0")
      )
      .join("")
  );
}

function mixColors(hex1: string, hex2: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(hex1);
  const [r2, g2, b2] = hexToRgb(hex2);
  return rgbToHex(
    r1 + (r2 - r1) * t,
    g1 + (g2 - g1) * t,
    b1 + (b2 - b1) * t
  );
}

export function deriveThemeVars(colors: ThemeColors): Record<string, string> {
  const { background, card, accent, primary } = colors;
  const [ar, ag, ab] = hexToRgb(accent);
  const secondary = mixColors(background, card, 0.5);
  const mutedFg = mixColors(background, primary, 0.55);

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
    "--destructive": "#e11d48",
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

function applyCustomThemeStyle(theme: ThemeDefinition) {
  let el = document.getElementById(
    "custom-theme-style"
  ) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = "custom-theme-style";
    document.head.appendChild(el);
  }
  const vars = deriveThemeVars(theme.colors);
  const cssText = Object.entries(vars)
    .map(([k, v]) => `${k}: ${v};`)
    .join("\n  ");
  el.textContent = `[data-theme="${theme.id}"] {\n  ${cssText}\n}`;
}

function removeCustomThemeStyle() {
  document.getElementById("custom-theme-style")?.remove();
}

export function useThemeSettings() {
  const [themeId, setThemeId] = useState<string>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) || "dark";
    } catch {
      return "dark";
    }
  });

  const [customThemes, setCustomThemes] = useState<ThemeDefinition[]>(() => {
    try {
      const raw = localStorage.getItem(CUSTOM_THEMES_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    const html = document.documentElement;
    if (themeId === "light") {
      html.classList.remove("dark");
      html.removeAttribute("data-theme");
      removeCustomThemeStyle();
    } else if (themeId === "dark") {
      html.classList.add("dark");
      html.removeAttribute("data-theme");
      removeCustomThemeStyle();
    } else {
      html.classList.add("dark");
      html.setAttribute("data-theme", themeId);
      const custom = customThemes.find((t) => t.id === themeId);
      if (custom) {
        applyCustomThemeStyle(custom);
      } else {
        removeCustomThemeStyle();
      }
    }
  }, [themeId, customThemes]);

  const setTheme = useCallback((id: string) => {
    setThemeId(id);
    localStorage.setItem(STORAGE_KEY, id);
  }, []);

  const addCustomTheme = useCallback(
    (name: string, colors: ThemeColors): ThemeDefinition => {
      const theme: ThemeDefinition = {
        id: `custom-${Date.now()}`,
        name,
        colors,
      };
      setCustomThemes((prev) => {
        const next = [...prev, theme];
        localStorage.setItem(CUSTOM_THEMES_KEY, JSON.stringify(next));
        return next;
      });
      return theme;
    },
    []
  );

  const updateCustomTheme = useCallback(
    (id: string, name: string, colors: ThemeColors) => {
      setCustomThemes((prev) => {
        const next = prev.map((t) =>
          t.id === id ? { ...t, name, colors } : t
        );
        localStorage.setItem(CUSTOM_THEMES_KEY, JSON.stringify(next));
        return next;
      });
    },
    []
  );

  const deleteCustomTheme = useCallback((id: string) => {
    setCustomThemes((prev) => {
      const next = prev.filter((t) => t.id !== id);
      localStorage.setItem(CUSTOM_THEMES_KEY, JSON.stringify(next));
      return next;
    });
    setThemeId((prev) => {
      if (prev === id) {
        localStorage.setItem(STORAGE_KEY, "dark");
        return "dark";
      }
      return prev;
    });
  }, []);

  const exportTheme = useCallback(
    (id: string): string | null => {
      const allThemes = [...THEMES, ...customThemes];
      const theme = allThemes.find((t) => t.id === id);
      if (!theme) return null;
      return JSON.stringify(
        {
          name: theme.name,
          background: theme.colors.background,
          card: theme.colors.card,
          accent: theme.colors.accent,
          primary: theme.colors.primary,
        },
        null,
        2
      );
    },
    [customThemes]
  );

  const importTheme = useCallback((json: string): ThemeDefinition => {
    const data = JSON.parse(json);
    if (
      !data.name ||
      !data.background ||
      !data.card ||
      !data.accent ||
      !data.primary
    ) {
      throw new Error(
        "Invalid theme JSON. Required: name, background, card, accent, primary"
      );
    }
    const theme: ThemeDefinition = {
      id: `custom-${Date.now()}`,
      name: data.name,
      colors: {
        background: data.background,
        card: data.card,
        accent: data.accent,
        primary: data.primary,
      },
    };
    setCustomThemes((prev) => {
      const next = [...prev, theme];
      localStorage.setItem(CUSTOM_THEMES_KEY, JSON.stringify(next));
      return next;
    });
    return theme;
  }, []);

  return {
    themeId,
    setTheme,
    customThemes,
    addCustomTheme,
    updateCustomTheme,
    deleteCustomTheme,
    exportTheme,
    importTheme,
  };
}
