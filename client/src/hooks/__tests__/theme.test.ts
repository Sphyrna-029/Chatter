/**
 * @vitest-environment jsdom
 *
 * The stylesheet is not loaded here, so anything that reads a built-in theme's
 * colours out of the CSS is exercised in the browser, not below. What is
 * testable in isolation is the part that used to be wrong: which base palette
 * a theme lands on, and what survives a round trip through export/import.
 */
import { describe, it, expect } from "vitest";
import {
  deriveThemeVars,
  parseImportedTheme,
  THEMES,
  type ThemeColors,
} from "@/lib/theme";
import { isDarkColor, mixColors, normalizeToHex } from "@/lib/color";

const PALE: ThemeColors = {
  background: "#fdfaf6",
  card: "#f1ece4",
  accent: "#c2410c",
  primary: "#1c1917",
};

describe("isDarkColor", () => {
  it("puts near-white and near-black on opposite palettes", () => {
    expect(isDarkColor("#ffffff")).toBe(false);
    expect(isDarkColor("#000000")).toBe(true);
  });

  it("keeps a mid grey on the dark palette", () => {
    // Discord's background is this sort of value; against the light palette's
    // near-black foreground it would be unreadable.
    expect(isDarkColor("#313338")).toBe(true);
  });
});

describe("deriveThemeVars", () => {
  it("leaves the status colours to the base block", () => {
    // Pinning these is what gave a pale custom theme the dark palette's
    // destructive red and status colours.
    const vars = deriveThemeVars(PALE);
    for (const name of [
      "--destructive",
      "--success",
      "--warning",
      "--info",
    ]) {
      expect(vars).not.toHaveProperty(name);
    }
  });

  it("maps the four inputs onto the variables that quote them directly", () => {
    const vars = deriveThemeVars(PALE);
    expect(vars["--background"]).toBe(PALE.background);
    expect(vars["--card"]).toBe(PALE.card);
    expect(vars["--accent"]).toBe(PALE.accent);
    expect(vars["--foreground"]).toBe(PALE.primary);
    expect(vars["--primary-foreground"]).toBe(PALE.background);
  });
});

describe("built-in themes", () => {
  it("declares no colours of its own", () => {
    // index.css is the one place a built-in's colours are written down.
    for (const theme of THEMES) {
      expect(theme.colors).toBeNull();
    }
  });

  it("has exactly one light base theme", () => {
    expect(THEMES.filter((t) => t.mode === "light").map((t) => t.id)).toEqual([
      "light",
    ]);
  });
});

describe("parseImportedTheme", () => {
  const json = (o: Record<string, unknown>) => JSON.stringify(o);

  it("infers a light base from a pale background", () => {
    const theme = parseImportedTheme(json({ name: "Parchment", ...PALE }));
    expect(theme.mode).toBe("light");
    expect(theme.colors).toEqual(PALE);
  });

  it("honours an explicit mode over the inferred one", () => {
    const theme = parseImportedTheme(
      json({ name: "Parchment", mode: "dark", ...PALE }),
    );
    expect(theme.mode).toBe("dark");
  });

  it("rejects a colour that is not one", () => {
    expect(() =>
      parseImportedTheme(json({ name: "Bad", ...PALE, accent: "not a colour" })),
    ).toThrow(/accent/);
  });

  it("rejects a missing field rather than filling it in", () => {
    const { accent: _accent, ...rest } = PALE;
    expect(() => parseImportedTheme(json({ name: "Bad", ...rest }))).toThrow(
      /accent/,
    );
  });

  it("gives two themes imported in the same millisecond different ids", () => {
    const a = parseImportedTheme(json({ name: "One", ...PALE }));
    const b = parseImportedTheme(json({ name: "One", ...PALE }));
    expect(a.id).not.toBe(b.id);
  });
});

describe("normalizeToHex", () => {
  it("passes hex through, lowercased", () => {
    expect(normalizeToHex("#AABBCC")).toBe("#aabbcc");
  });

  it("falls back where there is no canvas to convert with", () => {
    // jsdom has no 2d context, which is also the guard for a browser that
    // cannot parse the value at all.
    expect(normalizeToHex("oklch(0.16 0.03 260)", "#123456")).toBe("#123456");
  });
});

describe("mixColors", () => {
  it("returns the endpoints at 0 and 1", () => {
    expect(mixColors("#000000", "#ffffff", 0)).toBe("#000000");
    expect(mixColors("#000000", "#ffffff", 1)).toBe("#ffffff");
  });
});
