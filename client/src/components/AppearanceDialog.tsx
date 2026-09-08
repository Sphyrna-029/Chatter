import { useState, useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  useThemeSettings,
  resolveThemeColors,
  SYSTEM_THEME_ID,
  type ThemeColors,
  type ThemeMode,
} from "@/lib/theme";
import { isDarkColor } from "@/lib/color";

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
    themeId,
    activeTheme,
    systemTheme,
    themes,
    setTheme,
    addCustomTheme,
    updateCustomTheme,
    deleteCustomTheme,
    exportTheme,
    importTheme,
  } = useThemeSettings();

  const [creatingTheme, setCreatingTheme] = useState(false);
  const [editingThemeId, setEditingThemeId] = useState<string | null>(null);
  const [themeName, setThemeName] = useState("My Theme");
  const [themeColors, setThemeColors] = useState<ThemeColors>(NEW_THEME_COLORS);
  /** null follows the background colour; a value is an explicit choice. */
  const [themeMode, setThemeMode] = useState<ThemeMode | null>(null);
  const [copiedThemeId, setCopiedThemeId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importJson, setImportJson] = useState("");
  const [importError, setImportError] = useState("");

  const effectiveMode: ThemeMode =
    themeMode ?? (isDarkColor(themeColors.background) ? "dark" : "light");

  // Built-in swatches come out of the stylesheet, so what the picker shows is
  // what the theme actually renders. Cached per theme after the first read.
  const themeSwatches = useMemo(
    () => themes.map((theme) => ({ theme, colors: resolveThemeColors(theme) })),
    [themes],
  );

  // "System" is a standing instruction rather than a theme, so it has no
  // colours of its own — it previews whichever built-in it resolves to now.
  const systemColors = resolveThemeColors(systemTheme);

  const copy = async (id: string) => {
    const json = exportTheme(id);
    if (!json) return;
    try {
      await navigator.clipboard.writeText(json);
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
    setCreatingTheme(true);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Appearance</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
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
                          setCreatingTheme(true);
                        }}
                      >
                        Edit
                      </button>
                      <button
                        className="rounded bg-black/60 px-1.5 py-0.5 text-3xs text-white hover:bg-black/80"
                        onClick={() => copy(theme.id)}
                      >
                        {copiedThemeId === theme.id ? "Copied!" : "Copy"}
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
                    );
                  } else {
                    const t = addCustomTheme(
                      themeName.trim(),
                      themeColors,
                      effectiveMode,
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
                {copiedThemeId === activeTheme.id ? "Copied!" : "Export Current"}
              </Button>
            </div>
          )}

          {/* Import area */}
          {importOpen && !creatingTheme && (
            <div className="space-y-2 rounded-lg border border-muted-foreground/20 p-3">
              <textarea
                className="w-full h-24 rounded bg-background border border-input px-2 py-1.5 text-xs font-mono resize-none focus:outline-none focus:ring-1 focus:ring-ring"
                placeholder={
                  'Paste theme JSON here...\n{\n  "name": "...",\n  "background": "#...",\n  "card": "#...",\n  "accent": "#...",\n  "primary": "#..."\n}'
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
        </div>
      </DialogContent>
    </Dialog>
  );
}
