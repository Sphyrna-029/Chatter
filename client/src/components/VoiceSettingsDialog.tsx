import { useState, useEffect, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import { useVoiceSettings } from "@/hooks/useVoiceSettings";
import { useThemeSettings, THEMES, type ThemeColors } from "@/hooks/useThemeSettings";
import { Input } from "@/components/ui/input";

interface VoiceSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function VoiceSettingsDialog({
  open,
  onOpenChange,
}: VoiceSettingsDialogProps) {
  const { settings, updateSettings } = useVoiceSettings();
  const { themeId, setTheme, customThemes, addCustomTheme, updateCustomTheme, deleteCustomTheme, exportTheme, importTheme } = useThemeSettings();
  const [creatingTheme, setCreatingTheme] = useState(false);
  const [editingThemeId, setEditingThemeId] = useState<string | null>(null);
  const [themeName, setThemeName] = useState("My Theme");
  const [themeColors, setThemeColors] = useState<ThemeColors>({
    background: "#1a1a2e",
    card: "#25253e",
    accent: "#e94560",
    primary: "#eaeaea",
  });
  const [copiedThemeId, setCopiedThemeId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importJson, setImportJson] = useState("");
  const [importError, setImportError] = useState("");
  const [inputDevices, setInputDevices] = useState<MediaDeviceInfo[]>([]);
  const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[]>([]);
  const [micLevel, setMicLevel] = useState(0);
  const [isMonitoring, setIsMonitoring] = useState(false);

  const micTestRef = useRef<MediaStream | null>(null);
  const animFrameRef = useRef<number>(0);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const monitorAudioRef = useRef<HTMLAudioElement | null>(null);

  const loadDevices = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      const allDevices = await navigator.mediaDevices.enumerateDevices();
      setInputDevices(allDevices.filter((d) => d.kind === "audioinput"));
      setOutputDevices(allDevices.filter((d) => d.kind === "audiooutput"));
    } catch (err) {
      console.error("Could not load devices:", err);
    }
  };

  const stopMonitoring = () => {
    if (monitorAudioRef.current) {
      monitorAudioRef.current.pause();
      monitorAudioRef.current.srcObject = null;
      monitorAudioRef.current = null;
    }
    setIsMonitoring(false);
  };

  const startMonitoring = async () => {
    if (!micTestRef.current) return;
    stopMonitoring();
    const el = new Audio();
    el.srcObject = micTestRef.current;
    if ("setSinkId" in el && settings.outputDeviceId !== "default") {
      await (
        el as HTMLAudioElement & { setSinkId(id: string): Promise<void> }
      ).setSinkId(settings.outputDeviceId);
    }
    el.play();
    monitorAudioRef.current = el;
    setIsMonitoring(true);
  };

  const stopMicTest = () => {
    stopMonitoring();
    if (micTestRef.current) {
      micTestRef.current.getTracks().forEach((t) => t.stop());
      micTestRef.current = null;
    }
    cancelAnimationFrame(animFrameRef.current);
    analyserRef.current = null;
    gainNodeRef.current = null;
    if (audioCtxRef.current) {
      audioCtxRef.current.close();
      audioCtxRef.current = null;
    }
    setMicLevel(0);
    setIsMonitoring(false);
  };

  const startMicTest = async () => {
    stopMicTest();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId:
            settings.inputDeviceId !== "default"
              ? { exact: settings.inputDeviceId }
              : undefined,
          echoCancellation: settings.echoCancellation,
          noiseSuppression: settings.noiseSuppressionMode === "browser",
          autoGainControl: settings.autoGainControl,
          sampleRate: 48000,
        },
      });
      micTestRef.current = stream;

      const ctx = new AudioContext({ sampleRate: 48000 });
      audioCtxRef.current = ctx;
      await ctx.resume();

      const source = ctx.createMediaStreamSource(stream);

      const gainNode = ctx.createGain();
      gainNode.gain.value = settings.autoGainControl
        ? 1
        : Math.pow(10, settings.inputGainDb / 20);
      gainNodeRef.current = gainNode;

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyserRef.current = analyser;

      source.connect(gainNode);
      gainNode.connect(analyser);

      const tick = () => {
        const data = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteTimeDomainData(data);
        const rms = Math.sqrt(
          data.reduce((sum, v) => sum + (v - 128) ** 2, 0) / data.length,
        );
        setMicLevel(Math.min(100, rms * 5));
        animFrameRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch (err) {
      console.error("Mic test failed:", err);
    }
  };

  // Restart test when device changes mid-test
  useEffect(() => {
    if (micTestRef.current) startMicTest();
  }, [settings.inputDeviceId]);

  // Update gain node live without restarting
  useEffect(() => {
    if (gainNodeRef.current && !settings.autoGainControl) {
      gainNodeRef.current.gain.value = Math.pow(10, settings.inputGainDb / 20);
    }
  }, [settings.inputGainDb, settings.autoGainControl]);

  useEffect(() => {
    if (open) {
      loadDevices();
    } else {
      stopMicTest();
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="input">
          <TabsList className="w-full">
            <TabsTrigger value="input" className="flex-1">
              Input
            </TabsTrigger>
            <TabsTrigger value="output" className="flex-1">
              Output
            </TabsTrigger>
            <TabsTrigger value="advanced" className="flex-1">
              Advanced
            </TabsTrigger>
            <TabsTrigger value="theme" className="flex-1">
              Theme
            </TabsTrigger>
          </TabsList>

          {/* ── Input Tab ── */}
          <TabsContent value="input" className="space-y-5 mt-4">
            <div className="space-y-2">
              <Label>Microphone</Label>
              <select
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={settings.inputDeviceId}
                onChange={(e) =>
                  updateSettings({ inputDeviceId: e.target.value })
                }
              >
                {inputDevices.length === 0 && (
                  <option value="default">Default</option>
                )}
                {inputDevices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `Microphone (${d.deviceId.slice(0, 8)})`}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <Label>Mic Test</Label>
              <div className="flex items-center gap-2">
                <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full bg-green-500 transition-all duration-75"
                    style={{ width: `${micLevel}%` }}
                  />
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={micTestRef.current ? stopMicTest : startMicTest}
                >
                  {micTestRef.current ? "Stop" : "Test Mic"}
                </Button>
                {micTestRef.current && (
                  <Button
                    variant={isMonitoring ? "default" : "outline"}
                    size="sm"
                    onClick={isMonitoring ? stopMonitoring : startMonitoring}
                    title="Hear yourself through speakers"
                  >
                    {isMonitoring ? "🔊" : "🎧"}
                  </Button>
                )}
              </div>
              {isMonitoring && (
                <p className="text-xs text-yellow-500">
                  ⚠ Move away from speakers to avoid feedback loop
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label>Input Volume</Label>
              <div className="flex items-center gap-3">
                <Slider
                  className="flex-1"
                  min={0}
                  max={100}
                  step={1}
                  value={[settings.inputVolume]}
                  onValueChange={([v]) => updateSettings({ inputVolume: v })}
                />
                <span className="w-8 text-right text-xs text-muted-foreground">
                  {settings.inputVolume}%
                </span>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <Label>Echo Cancellation</Label>
                <p className="text-xs text-muted-foreground">
                  Reduces echo from speakers
                </p>
              </div>
              <Switch
                checked={settings.echoCancellation}
                onCheckedChange={(v) => updateSettings({ echoCancellation: v })}
              />
            </div>

            <div className="space-y-2">
              <Label>Noise Suppression</Label>
              <select
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={settings.noiseSuppressionMode}
                onChange={(e) =>
                  updateSettings({
                    noiseSuppressionMode: e.target.value as "none" | "browser",
                  })
                }
              >
                <option value="none">Off</option>
                <option value="browser">Browser built-in (fan, AC noise)</option>
              </select>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <Label>Auto Gain Control</Label>
                <p className="text-xs text-muted-foreground">
                  OS normalizes mic level automatically
                </p>
              </div>
              <Switch
                checked={settings.autoGainControl}
                onCheckedChange={(v) => updateSettings({ autoGainControl: v })}
              />
            </div>

            {/* Manual gain — only visible when AGC is off */}
            {!settings.autoGainControl && (
              <div className="space-y-2 rounded-md border border-input p-3">
                <Label>Input Gain</Label>
                <div className="flex items-center gap-3">
                  <Slider
                    className="flex-1"
                    min={-10}
                    max={30}
                    step={1}
                    value={[settings.inputGainDb]}
                    onValueChange={([v]) => updateSettings({ inputGainDb: v })}
                  />
                  <span className="w-14 text-right text-xs text-muted-foreground">
                    {settings.inputGainDb > 0 ? "+" : ""}
                    {settings.inputGainDb} dB
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  0 dB = no change · positive values amplify the mic signal
                </p>
              </div>
            )}
          </TabsContent>

          {/* ── Output Tab ── */}
          <TabsContent value="output" className="space-y-5 mt-4">
            <div className="space-y-2">
              <Label>Speaker</Label>
              <select
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={settings.outputDeviceId}
                onChange={(e) =>
                  updateSettings({ outputDeviceId: e.target.value })
                }
              >
                {outputDevices.length === 0 && (
                  <option value="default">Default</option>
                )}
                {outputDevices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `Speaker (${d.deviceId.slice(0, 8)})`}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                Changing output may require rejoining voice.
              </p>
            </div>

            <div className="space-y-2">
              <Label>Output Volume</Label>
              <div className="flex items-center gap-3">
                <Slider
                  className="flex-1"
                  min={0}
                  max={100}
                  step={1}
                  value={[settings.outputVolume]}
                  onValueChange={([v]) => updateSettings({ outputVolume: v })}
                />
                <span className="w-8 text-right text-xs text-muted-foreground">
                  {settings.outputVolume}%
                </span>
              </div>
            </div>
          </TabsContent>

          {/* ── Advanced Tab ── */}
          <TabsContent value="advanced" className="space-y-5 mt-4">
            <div className="flex items-center justify-between">
              <div>
                <Label>Push to Talk</Label>
                <p className="text-xs text-muted-foreground">
                  Hold backtick (`) to speak
                </p>
              </div>
              <Switch
                checked={settings.inputMode === "ptt"}
                onCheckedChange={(v) =>
                  updateSettings({ inputMode: v ? "ptt" : "open" })
                }
              />
            </div>
          </TabsContent>

          {/* ── Theme Tab ── */}
          <TabsContent value="theme" className="mt-4 space-y-4">
            <div className="grid grid-cols-2 gap-3">
              {[...THEMES, ...customThemes].map((theme) => {
                const isCustom = theme.id.startsWith("custom-");
                return (
                  <div key={theme.id} className="relative group">
                    <button
                      onClick={() => setTheme(theme.id)}
                      className={`w-full rounded-lg border-2 p-3 text-left transition-colors ${
                        themeId === theme.id
                          ? "border-primary"
                          : "border-muted-foreground/20 hover:border-muted-foreground/40"
                      }`}
                      style={{ backgroundColor: theme.colors.background }}
                    >
                      <span
                        className="block text-sm font-medium mb-2"
                        style={{ color: theme.colors.primary }}
                      >
                        {theme.name}
                      </span>
                      <div className="flex gap-1.5">
                        {Object.values(theme.colors).map((color, i) => (
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
                            setThemeColors(theme.colors);
                            setCreatingTheme(true);
                          }}
                        >
                          Edit
                        </button>
                        <button
                          className="rounded bg-black/60 px-1.5 py-0.5 text-3xs text-white hover:bg-black/80"
                          onClick={async () => {
                            const json = exportTheme(theme.id);
                            if (!json) return;
                            try {
                              await navigator.clipboard.writeText(json);
                              setCopiedThemeId(theme.id);
                              setTimeout(() => setCopiedThemeId(null), 2000);
                            } catch {}
                          }}
                        >
                          {copiedThemeId === theme.id ? "Copied!" : "Copy"}
                        </button>
                        <button
                          className="rounded bg-black/60 px-1.5 py-0.5 text-3xs text-red-400 hover:bg-black/80"
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
                      <span className="text-xs text-muted-foreground">{label}</span>
                    </label>
                  ))}
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
                      updateCustomTheme(editingThemeId, themeName.trim(), themeColors);
                    } else {
                      const t = addCustomTheme(themeName.trim(), themeColors);
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
                  onClick={() => {
                    setEditingThemeId(null);
                    setThemeName("My Theme");
                    setThemeColors({
                      background: "#1a1a2e",
                      card: "#25253e",
                      accent: "#e94560",
                      primary: "#eaeaea",
                    });
                    setCreatingTheme(true);
                  }}
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
                {themeId !== "light" && themeId !== "dark" && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1"
                    onClick={async () => {
                      const json = exportTheme(themeId);
                      if (!json) return;
                      try {
                        await navigator.clipboard.writeText(json);
                        setCopiedThemeId(themeId);
                        setTimeout(() => setCopiedThemeId(null), 2000);
                      } catch {}
                    }}
                  >
                    {copiedThemeId === themeId ? "Copied!" : "Export Current"}
                  </Button>
                )}
              </div>
            )}

            {/* Import area */}
            {importOpen && !creatingTheme && (
              <div className="space-y-2 rounded-lg border border-muted-foreground/20 p-3">
                <textarea
                  className="w-full h-24 rounded bg-background border border-input px-2 py-1.5 text-xs font-mono resize-none focus:outline-none focus:ring-1 focus:ring-ring"
                  placeholder={'Paste theme JSON here...\n{\n  "name": "...",\n  "background": "#...",\n  "card": "#...",\n  "accent": "#...",\n  "primary": "#..."\n}'}
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
                      } catch (e: any) {
                        setImportError(e.message || "Invalid JSON");
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
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
