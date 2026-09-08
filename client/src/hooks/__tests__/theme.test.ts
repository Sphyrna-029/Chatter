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
  checkContrast,
  isSafeThemeId,
  MIN_TEXT_CONTRAST,
  THEMES,
  type ThemeColors,
} from "@/lib/theme";
import {
  applyDisplaySettings,
  normalizeDisplay,
  prefersReducedMotion,
  scrollBehavior,
  DEFAULT_DISPLAY,
  FONT_SCALE_RANGE,
} from "@/lib/theme";
import {
  contrastRatio,
  isDarkColor,
  mixColors,
  mixToContrast,
  normalizeToHex,
} from "@/lib/color";

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

describe("normalizeDisplay", () => {
  it("falls back per field rather than discarding the set", () => {
    // A bad radius should not cost someone their text size.
    const d = normalizeDisplay({ fontScale: 1.2, radius: "big", density: "compact" });
    expect(d.fontScale).toBe(1.2);
    expect(d.radius).toBe(DEFAULT_DISPLAY.radius);
    expect(d.density).toBe("compact");
    expect(d.motion).toBe("system");
  });

  it("clamps a scale that would make the app unusable", () => {
    expect(normalizeDisplay({ fontScale: 40 }).fontScale).toBe(
      FONT_SCALE_RANGE.max,
    );
    expect(normalizeDisplay({ fontScale: 0 }).fontScale).toBe(
      FONT_SCALE_RANGE.min,
    );
  });

  it("reads anything unrecognised as the defaults", () => {
    expect(normalizeDisplay(null)).toEqual(DEFAULT_DISPLAY);
    expect(normalizeDisplay("compact")).toEqual(DEFAULT_DISPLAY);
    expect(normalizeDisplay({ motion: "sideways" }).motion).toBe("system");
  });
});

describe("applyDisplaySettings", () => {
  const html = () => document.documentElement;

  it("writes a default as an absence, not as its value", () => {
    // So a later change to what "comfortable" means still reaches everyone who
    // never touched the setting.
    applyDisplaySettings(DEFAULT_DISPLAY);
    expect(html().getAttribute("data-density")).toBeNull();
    expect(html().getAttribute("data-motion")).toBeNull();
    expect(html().style.getPropertyValue("--font-scale")).toBe("");
    expect(html().style.getPropertyValue("--radius")).toBe("");
  });

  it("applies and then clears a non-default", () => {
    applyDisplaySettings({
      ...DEFAULT_DISPLAY,
      fontScale: 1.2,
      radius: 0,
      density: "compact",
      motion: "reduce",
    });
    expect(html().style.getPropertyValue("--font-scale")).toBe("1.2");
    expect(html().style.getPropertyValue("--radius")).toBe("0rem");
    expect(html().getAttribute("data-density")).toBe("compact");
    expect(html().getAttribute("data-motion")).toBe("reduce");

    applyDisplaySettings(DEFAULT_DISPLAY);
    expect(html().getAttribute("data-density")).toBeNull();
    expect(html().style.getPropertyValue("--font-scale")).toBe("");
  });
});

describe("prefersReducedMotion", () => {
  it("lets the in-app choice override the OS either way", () => {
    document.documentElement.setAttribute("data-motion", "reduce");
    expect(prefersReducedMotion()).toBe(true);
    expect(scrollBehavior()).toBe("auto");

    document.documentElement.setAttribute("data-motion", "full");
    expect(prefersReducedMotion()).toBe(false);
    expect(scrollBehavior()).toBe("smooth");

    document.documentElement.removeAttribute("data-motion");
  });
});

describe("contrastRatio", () => {
  it("returns the known endpoints", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
  });

  it("does not depend on the order of the arguments", () => {
    expect(contrastRatio("#123456", "#abcdef")).toBeCloseTo(
      contrastRatio("#abcdef", "#123456"),
      10,
    );
  });
});

describe("mixToContrast", () => {
  it("keeps the starting mix when it already reads", () => {
    // 55% from white toward black clears 4.5:1 on its own, so the floor must
    // not darken it further and change the look for no reason.
    const plain = mixColors("#ffffff", "#000000", 0.55);
    expect(mixToContrast("#ffffff", "#000000", "#ffffff", 4.5, 0.55)).toBe(
      plain,
    );
  });

  it("pushes further when the starting mix does not read", () => {
    // Mid grey on mid grey: 55% of the way to a near-grey foreground is
    // invisible, so it has to keep going.
    const bg = "#767676";
    const fg = "#8a8a8a";
    const plain = mixColors(bg, fg, 0.55);
    const floored = mixToContrast(bg, fg, bg, 4.5, 0.55);
    expect(floored).not.toBe(plain);
  });

  it("gives up at the far end rather than looping", () => {
    // No mix of two near-identical colours can clear 4.5:1 against one of them.
    expect(mixToContrast("#777777", "#787878", "#777777", 4.5, 0.55)).toBe(
      "#787878",
    );
  });
});

describe("checkContrast", () => {
  it("flags the pair that fails and not the ones that pass", () => {
    const checks = checkContrast({
      background: "#ffffff",
      card: "#ffffff",
      accent: "#1a1a1a",
      primary: "#111111",
    });
    const byLabel = Object.fromEntries(checks.map((c) => [c.label, c]));
    expect(byLabel["Text on background"].passes).toBe(true);
    expect(byLabel["Text on cards"].passes).toBe(true);
    // Near-black text on a near-black accent.
    expect(byLabel["Text on accent"].passes).toBe(false);
  });

  it("agrees with the threshold it is checked against", () => {
    for (const check of checkContrast(PALE)) {
      expect(check.passes).toBe(check.ratio >= MIN_TEXT_CONTRAST);
    }
  });
});

describe("derived muted foreground", () => {
  // Backgrounds paired with a foreground a real theme would use with them.
  const pairs: [string, string][] = [
    ["#ffffff", "#111111"],
    ["#000000", "#eeeeee"],
    ["#313338", "#f2f3f5"],
    ["#fdfaf6", "#1c1917"],
  ];

  it("clears the text threshold against the background it sits on", () => {
    // The old fixed 55% mix produced whatever it produced, which on some
    // backgrounds was secondary text nobody could read.
    for (const [background, primary] of pairs) {
      const vars = deriveThemeVars({
        background,
        card: background,
        accent: "#888888",
        primary,
      });
      expect(
        contrastRatio(vars["--muted-foreground"], background),
      ).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    }
  });

  it("stays at the plain mix where that already reads", () => {
    // The floor is a floor, not a restyle: a pair that was already fine keeps
    // the muted tone it had. (The white/near-black pair is not one of those —
    // 55% of the way down from white lands at 3.9:1, which is the bug.)
    const [background, primary] = pairs[1];
    const vars = deriveThemeVars({
      background,
      card: background,
      accent: "#888888",
      primary,
    });
    expect(vars["--muted-foreground"]).toBe(
      mixColors(background, primary, 0.55),
    );
  });
});

describe("isSafeThemeId", () => {
  it("accepts the ids the app mints", () => {
    expect(isSafeThemeId("dark")).toBe(true);
    expect(isSafeThemeId("cotton-candy")).toBe(true);
    expect(isSafeThemeId("custom-m1x2y3-a9f0kd")).toBe(true);
  });

  it("rejects anything that could end the CSS selector's string", () => {
    // The id is interpolated into html[data-theme="..."]; a quote in it would
    // let a stored theme write arbitrary rules into the page.
    expect(isSafeThemeId('x"] { display: none } html[data-theme="x')).toBe(
      false,
    );
    expect(isSafeThemeId("has space")).toBe(false);
    expect(isSafeThemeId("")).toBe(false);
    expect(isSafeThemeId(null)).toBe(false);
    expect(isSafeThemeId("x".repeat(65))).toBe(false);
  });
});
