import { useState, useEffect } from "react";

export interface ThemeDefinition {
  id: string;
  name: string;
  colors: {
    background: string;
    card: string;
    accent: string;
    primary: string;
  };
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
];

const STORAGE_KEY = "chatter_theme";

export function useThemeSettings() {
  const [themeId, setThemeId] = useState<string>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) || "dark";
    } catch {
      return "dark";
    }
  });

  useEffect(() => {
    const html = document.documentElement;
    if (themeId === "light") {
      html.classList.remove("dark");
      html.removeAttribute("data-theme");
    } else if (themeId === "dark") {
      html.classList.add("dark");
      html.removeAttribute("data-theme");
    } else {
      html.classList.add("dark");
      html.setAttribute("data-theme", themeId);
    }
  }, [themeId]);

  const setTheme = (id: string) => {
    setThemeId(id);
    localStorage.setItem(STORAGE_KEY, id);
  };

  return { themeId, setTheme };
}
