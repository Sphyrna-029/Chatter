import { useState, useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  useThemeSettings,
  resolveThemeColors,
  checkContrast,
  DEFAULT_BORDER_STRENGTH,
  DEFAULT_DISPLAY,
  FONT_SCALE_RANGE,
  MIN_TEXT_CONTRAST,
  RADIUS_RANGE,
  SYSTEM_THEME_ID,
  type ThemeAdvanced,
  type ThemeColors,
  type ThemeMode,
} from "@/lib/theme";
import { isDarkColor, mixColors } from "@/lib/color";
import { themeShareLink } from "@/lib/theme";

const NEW_THEME_COLORS: ThemeColors = {
  background: "#1a1a2e",
  card: "#25253e",
  accent: "#e94560",
  primary: "#eaeaea",
};

interface AppearanceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AppearanceDialog({ open, onOpenChange }: AppearanceDialogProps) {
  const {
    display,
    setDisplay,
    resetDisplay,
    themeId,
    activeTheme,
    systemTheme,
    themes,
    setTheme,
    addCustomTheme,
    updateCustomTheme,
    deleteCustomTheme,
    shareTheme,
    importTheme,
  } = useThemeSettings();

  const [creatingTheme, setCreatingTheme] = useState(false);
  const [editingThemeId, setEditingThemeId] = useState<string | null>(null);
  const [themeName, setThemeName] = useState("My Theme");
  const [themeColors, setThemeColors] = useState<ThemeColors>(NEW_THEME_COLORS);
  /** null follows the background colour; a value is an explicit choice. */
  const [themeMode, setThemeMode] = useState<ThemeMode | null>(null);
  /** Each field absent means "derive it"; the editor shows the derived value
   *  and only stores an override once one is turned on. */
  const [advanced, setAdvanced] = useState<ThemeAdvanced>({});
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [copiedThemeId, setCopiedThemeId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importJson, setImportJson] = useState("");
  const [importError, setImportError] = useState("");

  const effectiveMode: ThemeMode =
    themeMode ?? (isDarkColor(themeColors.background) ? "dark" : "light");

  const contrast = useMemo(() => checkContrast(themeColors), [themeColors]);
  const failing = contrast.filter((c) => !c.passes);

  // Built-in swatches come out of the stylesheet, so what the picker shows is
  // what the theme actually renders. Cached per theme after the first read.
  const themeSwatches = useMemo(
    () => themes.map((theme) => ({ theme, colors: resolveThemeColors(theme) })),
    [themes],
  );

  // "System" is a standing instruction rather than a theme, so it has no
  // colours of its own — it previews whichever built-in it resolves to now.
  const systemColors = resolveThemeColors(systemTheme);

  /** Copies a link rather than the code alone: a link is what survives being
   *  pasted into a chat message, and it carries the code inside it. */
  const copy = async (id: string) => {
    const code = shareTheme(id);
    if (!code) return;
    try {
      await navigator.clipboard.writeText(themeShareLink(code));
      setCopiedThemeId(id);
      setTimeout(() => setCopiedThemeId(null), 2000);
    } catch {
      // No clipboard permission; nothing useful to say beyond the copy not
      // happening, and the button simply does not confirm.
    }
  };

  const startCreating = () => {
    setEditingThemeId(null);
    setThemeName("My Theme");
    setThemeColors(NEW_THEME_COLORS);
    setThemeMode(null);
    setAdvanced({});
    setAdvancedOpen(false);
    setCreatingTheme(true);
  };

  const savedAdvanced = () =>
    Object.keys(advanced).length > 0 ? advanced : undefined;

  /** What the theme would use for an override that is switched off. */
  const derived = {
    sidebar: mixColors(themeColors.background, themeColors.card, 0.3),
    mention: "#fbbf24",
  };

  const toggleOverride = (key: "sidebar" | "mention") =>
    setAdvanced((prev) => {
      const next = { ...prev };
      if (next[key] === undefined) next[key] = derived[key];
      else delete next[key];
      return next;
    });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Appearance</DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="theme">
          <TabsList className="w-full">
            <TabsTrigger value="theme" className="flex-1">
              Theme
            </TabsTrigger>
            <TabsTrigger value="display" className="flex-1">
              Display
            </TabsTrigger>
          </TabsList>

          <TabsContent value="theme" className="mt-4 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => setTheme(SYSTEM_THEME_ID)}
              className={`w-full rounded-lg border-2 p-3 text-left transition-colors ${
                themeId === SYSTEM_THEME_ID
                  ? "border-primary"
                  : "border-muted-foreground/20 hover:border-muted-foreground/40"
              }`}
              style={{ backgroundColor: systemColors.background }}
            >
              <span
                className="block text-sm font-medium"
                style={{ color: systemColors.primary }}
              >
                System
              </span>
              <span
                className="mb-2 block text-3xs"
                style={{ color: systemColors.accent }}
              >
                Following {systemTheme.name}
              </span>
              <div className="flex gap-1.5">
                {Object.values(systemColors).map((color, i) => (
                  <div
                    key={i}
                    className="h-4 w-4 rounded-full border border-white/10"
                    style={{ backgroundColor: color }}
                  />
                ))}
              </div>
            </button>

            {themeSwatches.map(({ theme, colors }) => {
              const isCustom = theme.colors !== null;
              return (
                <div key={theme.id} className="relative group">
                  <button
                    onClick={() => setTheme(theme.id)}
                    className={`w-full rounded-lg border-2 p-3 text-left transition-colors ${
                      themeId === theme.id
                        ? "border-primary"
                        : "border-muted-foreground/20 hover:border-muted-foreground/40"
                    }`}
                    style={{ backgroundColor: colors.background }}
                  >
                    <span
                      className="block text-sm font-medium mb-2"
                      style={{ color: colors.primary }}
                    >
                      {theme.name}
                    </span>
                    <div className="flex gap-1.5">
                      {Object.values(colors).map((color, i) => (
                        <div
                          key={i}
                          className="h-4 w-4 rounded-full border border-white/10"
                          style={{ backgroundColor: color }}
                        />
                      ))}
                    </div>
                  </button>
                  {isCustom && (
                    <div className="absolute top-1 right-1 flex gap-1 can-hover:opacity-0 can-hover:group-hover:opacity-100 transition-opacity">
                      <button
                        className="rounded bg-black/60 px-1.5 py-0.5 text-3xs text-white hover:bg-black/80"
                        onClick={() => {
                          setEditingThemeId(theme.id);
                          setThemeName(theme.name);
                          setThemeColors(colors);
                          setThemeMode(theme.mode);
                          setAdvanced(theme.advanced ?? {});
                          setAdvancedOpen(theme.advanced !== undefined);
                          setCreatingTheme(true);
                        }}
                      >
                        Edit
                      </button>
                      <button
                        className="rounded bg-black/60 px-1.5 py-0.5 text-3xs text-white hover:bg-black/80"
                        onClick={() => copy(theme.id)}
                      >
                        {copiedThemeId === theme.id ? "Copied!" : "Share"}
                      </button>
                      <button
                        className="rounded bg-black/60 px-1.5 py-0.5 text-3xs text-destructive hover:bg-black/80"
                        onClick={() => deleteCustomTheme(theme.id)}
                      >
                        Del
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Create / Edit custom theme */}
          {creatingTheme ? (
            <div className="space-y-3 rounded-lg border border-muted-foreground/20 p-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">
                  {editingThemeId ? "Edit Theme" : "New Theme"}
                </span>
                <button
                  className="text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    setCreatingTheme(false);
                    setEditingThemeId(null);
                  }}
                >
                  Cancel
                </button>
              </div>
              <Input
                value={themeName}
                onChange={(e) => setThemeName(e.target.value)}
                placeholder="Theme name"
                className="h-8 text-sm"
              />
              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    ["background", "Background"],
                    ["card", "Card"],
                    ["accent", "Accent"],
                    ["primary", "Primary"],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key} className="flex items-center gap-2">
                    <input
                      type="color"
                      value={themeColors[key]}
                      onChange={(e) =>
                        setThemeColors((c) => ({ ...c, [key]: e.target.value }))
                      }
                      className="h-7 w-7 rounded border-0 bg-transparent cursor-pointer [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:rounded"
                    />
                    <span className="text-xs text-muted-foreground">
                      {label}
                    </span>
                  </label>
                ))}
              </div>

              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <Label className="text-xs">Base palette</Label>
                  <p className="ui-hint">
                    Decides the colours a theme does not name for itself —
                    error, success, warning. Follows the background until you
                    pick.
                  </p>
                </div>
                <div className="flex shrink-0 rounded-md border border-muted-foreground/20 p-0.5">
                  {(["light", "dark"] as const).map((m) => (
                    <button
                      key={m}
                      onClick={() => setThemeMode(m)}
                      className={`rounded px-2 py-1 text-2xs capitalize transition-colors ${
                        effectiveMode === m
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              </div>

              <div className="rounded-md border border-muted-foreground/20">
                <button
                  className="flex w-full items-center justify-between gap-2 p-2.5 text-left"
                  onClick={() => setAdvancedOpen((v) => !v)}
                >
                  <Label className="text-xs cursor-pointer">
                    Derived colours
                  </Label>
                  <span className="ui-hint">
                    {Object.keys(advanced).length > 0
                      ? `${Object.keys(advanced).length} overridden`
                      : "All derived"}
                  </span>
                </button>
                {advancedOpen && (
                  <div className="space-y-3 border-t border-muted-foreground/20 p-2.5">
                    {(
                      [
                        ["sidebar", "Sidebar"],
                        ["mention", "Mention highlight"],
                      ] as const
                    ).map(([key, label]) => {
                      const overridden = advanced[key] !== undefined;
                      return (
                        <div
                          key={key}
                          className="flex items-center justify-between gap-2"
                        >
                          <span className="text-xs text-muted-foreground">
                            {label}
                          </span>
                          <div className="flex items-center gap-2">
                            <input
                              type="color"
                              disabled={!overridden}
                              value={advanced[key] ?? derived[key]}
                              onChange={(e) =>
                                setAdvanced((prev) => ({
                                  ...prev,
                                  [key]: e.target.value,
                                }))
                              }
                              className="h-6 w-6 rounded border-0 bg-transparent cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:rounded"
                            />
                            <button
                              onClick={() => toggleOverride(key)}
                              className="rounded border border-muted-foreground/20 px-1.5 py-0.5 text-3xs text-muted-foreground hover:text-foreground"
                            >
                              {overridden ? "Derive" : "Override"}
                            </button>
                          </div>
                        </div>
                      );
                    })}

                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs text-muted-foreground">
                          Border strength
                        </span>
                        <span className="text-2xs text-muted-foreground tabular-nums">
                          {Math.round(
                            (advanced.borderStrength ??
                              DEFAULT_BORDER_STRENGTH) * 100,
                          )}
                          %
                        </span>
                      </div>
                      <Slider
                        min={0}
                        max={1}
                        step={0.05}
                        value={[
                          advanced.borderStrength ?? DEFAULT_BORDER_STRENGTH,
                        ]}
                        onValueChange={([borderStrength]) =>
                          setAdvanced((prev) => ({ ...prev, borderStrength }))
                        }
                      />
                    </div>
                  </div>
                )}
              </div>

              <div className="space-y-1.5 rounded-md border border-muted-foreground/20 p-2.5">
                <div className="flex items-baseline justify-between gap-2">
                  <Label className="text-xs">Contrast</Label>
                  <span className="ui-hint">
                    {MIN_TEXT_CONTRAST}:1 needed
                  </span>
                </div>
                {contrast.map((check) => (
                  <div
                    key={check.label}
                    className="flex items-center justify-between gap-2 text-2xs"
                  >
                    <span className="text-muted-foreground">{check.label}</span>
                    <span
                      className={
                        check.passes
                          ? "text-success tabular-nums"
                          : "text-warning font-medium tabular-nums"
                      }
                    >
                      {check.ratio.toFixed(1)}:1
                    </span>
                  </div>
                ))}
                {failing.length > 0 && (
                  <p className="ui-hint">
                    {failing.length === 1
                      ? `${failing[0].label.toLowerCase()} will be hard to read.`
                      : "Some text will be hard to read."}{" "}
                    Saving anyway is fine — this is a warning, not a limit.
                  </p>
                )}
              </div>

              {/* Live preview */}
              <div
                className="rounded-lg p-3"
                style={{ backgroundColor: themeColors.background }}
              >
                <span
                  className="block text-sm font-medium mb-2"
                  style={{ color: themeColors.primary }}
                >
                  {themeName || "Preview"}
                </span>
                <div className="flex gap-1.5">
                  {Object.values(themeColors).map((color, i) => (
                    <div
                      key={i}
                      className="h-4 w-4 rounded-full border border-white/10"
                      style={{ backgroundColor: color }}
                    />
                  ))}
                </div>
              </div>
              <Button
                size="sm"
                className="w-full"
                disabled={!themeName.trim()}
                onClick={() => {
                  if (editingThemeId) {
                    updateCustomTheme(
                      editingThemeId,
                      themeName.trim(),
                      themeColors,
                      effectiveMode,
                      savedAdvanced(),
                    );
                  } else {
                    const t = addCustomTheme(
                      themeName.trim(),
                      themeColors,
                      effectiveMode,
                      savedAdvanced(),
                    );
                    setTheme(t.id);
                  }
                  setCreatingTheme(false);
                  setEditingThemeId(null);
                }}
              >
                {editingThemeId ? "Update Theme" : "Create & Apply"}
              </Button>
            </div>
          ) : (
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="flex-1"
                onClick={startCreating}
              >
                Create Theme
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="flex-1"
                onClick={() => {
                  setImportOpen(!importOpen);
                  setImportError("");
                  setImportJson("");
                }}
              >
                Import Theme
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="flex-1"
                onClick={() => copy(activeTheme.id)}
              >
                {copiedThemeId === activeTheme.id ? "Link copied!" : "Share Current"}
              </Button>
            </div>
          )}

          {/* Import area */}
          {importOpen && !creatingTheme && (
            <div className="space-y-2 rounded-lg border border-muted-foreground/20 p-3">
              <textarea
                className="w-full h-24 rounded bg-background border border-input px-2 py-1.5 text-xs font-mono resize-none focus:outline-none focus:ring-1 focus:ring-ring"
                placeholder={
                  "Paste a theme link, a share code, or theme JSON…\n\nhttps://…/?theme=ct1_…\nct1_…"
                }
                value={importJson}
                onChange={(e) => {
                  setImportJson(e.target.value);
                  setImportError("");
                }}
              />
              {importError && (
                <p className="text-xs text-destructive">{importError}</p>
              )}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  className="flex-1"
                  disabled={!importJson.trim()}
                  onClick={() => {
                    try {
                      const t = importTheme(importJson);
                      setTheme(t.id);
                      setImportOpen(false);
                      setImportJson("");
                    } catch (e) {
                      setImportError(
                        e instanceof Error ? e.message : "Invalid JSON",
                      );
                    }
                  }}
                >
                  Import & Apply
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setImportOpen(false);
                    setImportJson("");
                    setImportError("");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
          </TabsContent>

          <TabsContent value="display" className="mt-4 space-y-5">
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <Label>Text size</Label>
                <span className="w-12 text-right text-xs text-muted-foreground">
                  {Math.round(display.fontScale * 100)}%
                </span>
              </div>
              <Slider
                min={FONT_SCALE_RANGE.min}
                max={FONT_SCALE_RANGE.max}
                step={FONT_SCALE_RANGE.step}
                value={[display.fontScale]}
                onValueChange={([fontScale]) => setDisplay({ fontScale })}
              />
              <p className="ui-hint">
                Scales the whole interface, not just message text — spacing and
                controls are sized from the same root.
              </p>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <Label>Corner radius</Label>
                <span className="w-12 text-right text-xs text-muted-foreground">
                  {display.radius}rem
                </span>
              </div>
              <Slider
                min={RADIUS_RANGE.min}
                max={RADIUS_RANGE.max}
                step={RADIUS_RANGE.step}
                value={[display.radius]}
                onValueChange={([radius]) => setDisplay({ radius })}
              />
              <div
                className="h-8 border border-border bg-secondary"
                style={{ borderRadius: `${display.radius}rem` }}
              />
            </div>

            <div className="space-y-2">
              <Label>Density</Label>
              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    ["comfortable", "Comfortable"],
                    ["compact", "Compact"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    onClick={() => setDisplay({ density: value })}
                    className={`rounded-md border px-3 py-2 text-xs transition-colors ${
                      display.density === value
                        ? "border-primary bg-accent/40"
                        : "border-muted-foreground/20 hover:border-muted-foreground/40"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p className="ui-hint">
                Compact tightens the space above and below each message.
              </p>
            </div>

            <div className="space-y-2">
              <Label>Motion</Label>
              <div className="grid grid-cols-3 gap-2">
                {(
                  [
                    ["system", "System"],
                    ["reduce", "Reduced"],
                    ["full", "Full"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    onClick={() => setDisplay({ motion: value })}
                    className={`rounded-md border px-3 py-2 text-xs transition-colors ${
                      display.motion === value
                        ? "border-primary bg-accent/40"
                        : "border-muted-foreground/20 hover:border-muted-foreground/40"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p className="ui-hint">
                System follows what the operating system asks for. The other two
                override it here only.
              </p>
            </div>

            <Button
              variant="outline"
              size="sm"
              className="w-full"
              disabled={
                display.fontScale === DEFAULT_DISPLAY.fontScale &&
                display.radius === DEFAULT_DISPLAY.radius &&
                display.density === DEFAULT_DISPLAY.density &&
                display.motion === DEFAULT_DISPLAY.motion
              }
              onClick={resetDisplay}
            >
              Reset to defaults
            </Button>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
