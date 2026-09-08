import { createContext, useContext } from "react";
import type { ThemeSettings } from "./themes";

export const ThemeContext = createContext<ThemeSettings | null>(null);

export function useThemeSettings(): ThemeSettings {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useThemeSettings must be within ThemeProvider");
  return ctx;
}
