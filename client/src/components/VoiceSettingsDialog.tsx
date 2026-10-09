import { useState, useEffect, useRef, useMemo } from "react";
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
import { micGain, useVoiceSettings, type NoiseSuppressionMode } from "@/hooks/useVoiceSettings";
import {
  nativeVoiceAvailable,
  nativeVoicePreferred,
  selectVoiceBackend,
  setNativeVoicePreferred,
  type AudioDevice,
  type MicTest,
} from "@/lib/media";
import { desktop, hasDesktopFeature, type PttBinding } from "@/lib/desktop/bridge";

interface VoiceSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const NOISE_LABELS: Record<NoiseSuppressionMode, string> = {
  none: "Off",
  browser: "Standard (fan, AC noise)",
  rnnoise: "Enhanced (keyboard, voices in the room)",
};

export function VoiceSettingsDialog({
  open,
  onOpenChange,
}: VoiceSettingsDialogProps) {
  const { settings, updateSettings } = useVoiceSettings();
  const [nativeVoice, setNativeVoice] = useState(() => nativeVoicePreferred());
  // The stack the next call will use: devices and the mic test come from it,
  // since the desktop app's native engine names devices its own way.
  const backend = useMemo(() => selectVoiceBackend(), [nativeVoice]);
  const [inputDevices, setInputDevices] = useState<AudioDevice[]>([]);
  const [outputDevices, setOutputDevices] = useState<AudioDevice[]>([]);
  const [micLevel, setMicLevel] = useState(0);
  const [isMonitoring, setIsMonitoring] = useState(false);
  const [testing, setTesting] = useState(false);
  const [pttBinding, setPttBinding] = useState<PttBinding | null>(null);
  const [capturingKey, setCapturingKey] = useState(false);
  const desktopDucking = hasDesktopFeature("ducking") ? desktop?.ducking : undefined;
  const [ducking, setDucking] = useState<number | null>(null);

  const micTestRef = useRef<MicTest | null>(null);
  const desktopPtt = hasDesktopFeature("ptt") ? desktop?.pushToTalk : undefined;

  const loadDevices = async () => {
    try {
      const devices = await backend.listDevices();
      setInputDevices(devices.inputs);
      setOutputDevices(devices.outputs);
    } catch (err) {
      console.error("Could not load devices:", err);
    }
  };

  const stopMonitoring = () => {
    void micTestRef.current?.setMonitoring(false);
    setIsMonitoring(false);
  };

  const startMonitoring = async () => {
    if (!micTestRef.current) return;
    await micTestRef.current.setMonitoring(true);
    setIsMonitoring(true);
  };

  const stopMicTest = () => {
    micTestRef.current?.stop();
    micTestRef.current = null;
    setTesting(false);
    setMicLevel(0);
    setIsMonitoring(false);
  };

  const startMicTest = async () => {
    stopMicTest();
    try {
      micTestRef.current = await backend.startMicTest(
        {
          deviceId: settings.inputDeviceId,
          echoCancellation: settings.echoCancellation,
          noiseSuppression: settings.noiseSuppressionMode,
          autoGainControl: settings.autoGainControl,
          gain: micGain(settings),
          outputDeviceId: settings.outputDeviceId,
        },
        setMicLevel,
      );
      setTesting(true);
    } catch (err) {
      console.error("Mic test failed:", err);
    }
  };

  // Restart test when device or processing changes mid-test
  useEffect(() => {
    if (micTestRef.current) startMicTest();
  }, [settings.inputDeviceId, settings.noiseSuppressionMode, settings.echoCancellation, backend]);

  // Update gain live without restarting
  useEffect(() => {
    micTestRef.current?.setGain(micGain(settings));
  }, [settings.inputGainDb, settings.autoGainControl, settings.inputVolume]);

  useEffect(() => {
    if (!open) {
      stopMicTest();
      return;
    }
    loadDevices();
    void desktopPtt?.getBinding().then(setPttBinding).catch(() => {});
    void desktopDucking?.get().then(setDucking).catch(() => {});
    return backend.onDevicesChanged(() => void loadDevices());
  }, [open, backend]);

  // A mode this stack can't run (enhanced suppression after switching native
  // voice off) falls back to the standard one.
  const noiseModes = backend.noiseSuppressionModes;
  useEffect(() => {
    if (!noiseModes.includes(settings.noiseSuppressionMode)) {
      updateSettings({ noiseSuppressionMode: noiseModes.includes("browser") ? "browser" : noiseModes[0] });
    }
  }, [noiseModes, settings.noiseSuppressionMode]);

  const captureKey = async () => {
    if (!desktopPtt) return;
    setCapturingKey(true);
    try {
      const binding = await desktopPtt.captureBinding();
      if (binding) setPttBinding(binding);
    } finally {
      setCapturingKey(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85dvh] grid-rows-[auto_minmax(0,1fr)]">
        <DialogHeader>
          <DialogTitle>Voice &amp; Audio</DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="input" className="min-h-0">
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
          </TabsList>

          {/* ── Input Tab ── */}
          <TabsContent value="input" className="space-y-5 mt-4 min-h-0 overflow-y-auto pr-1">
            <div className="space-y-2">
              <Label>Microphone</Label>
              <select
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={settings.inputDeviceId}
                onChange={(e) =>
                  updateSettings({ inputDeviceId: e.target.value })
                }
              >
                {!inputDevices.some((d) => d.id === settings.inputDeviceId) && (
                  <option value={settings.inputDeviceId}>Default</option>
                )}
                {inputDevices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <Label>Mic Test</Label>
              <div className="flex items-center gap-2">
                <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full bg-success transition-all duration-75"
                    style={{ width: `${micLevel}%` }}
                  />
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={testing ? stopMicTest : startMicTest}
                >
                  {testing ? "Stop" : "Test Mic"}
                </Button>
                {testing && (
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
                <p className="text-xs text-warning">
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

            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
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
                    noiseSuppressionMode: e.target.value as NoiseSuppressionMode,
                  })
                }
              >
                {noiseModes.map((mode) => (
                  <option key={mode} value={mode}>
                    {NOISE_LABELS[mode]}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
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
          <TabsContent value="output" className="space-y-5 mt-4 min-h-0 overflow-y-auto pr-1">
            <div className="space-y-2">
              <Label>Speaker</Label>
              <select
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={settings.outputDeviceId}
                onChange={(e) =>
                  updateSettings({ outputDeviceId: e.target.value })
                }
              >
                {!outputDevices.some((d) => d.id === settings.outputDeviceId) && (
                  <option value={settings.outputDeviceId}>Default</option>
                )}
                {outputDevices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                  </option>
                ))}
              </select>
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

            {desktopDucking && ducking !== null && (
              <div className="space-y-2">
                <Label>Lower Other Apps</Label>
                <p className="text-xs text-muted-foreground">
                  Turns down games and music while people in the call are talking.
                </p>
                <div className="flex items-center gap-3">
                  <Slider
                    className="flex-1"
                    min={0}
                    max={100}
                    step={5}
                    value={[Math.round(ducking * 100)]}
                    onValueChange={([v]) => {
                      setDucking(v / 100);
                      void desktopDucking.set(v / 100);
                    }}
                  />
                  <span className="w-10 text-right text-xs text-muted-foreground">
                    {ducking === 0 ? "Off" : `${Math.round(ducking * 100)}%`}
                  </span>
                </div>
              </div>
            )}
          </TabsContent>

          {/* ── Advanced Tab ── */}
          <TabsContent value="advanced" className="space-y-5 mt-4 min-h-0 overflow-y-auto pr-1">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <Label>Push to Talk</Label>
                <p className="text-xs text-muted-foreground">
                  {desktopPtt
                    ? `Hold ${pttBinding?.label ?? "your key"} to speak, even while Chatter isn't focused`
                    : "Hold backtick (`) to speak"}
                </p>
              </div>
              <Switch
                checked={settings.inputMode === "ptt"}
                onCheckedChange={(v) =>
                  updateSettings({ inputMode: v ? "ptt" : "open" })
                }
              />
            </div>

            {desktopPtt && (
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <Label>Push to Talk Key</Label>
                  <p className="text-xs text-muted-foreground">
                    {capturingKey ? "Press the key or mouse button to use…" : (pttBinding?.label ?? "Not set")}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={captureKey} disabled={capturingKey}>
                    Change
                  </Button>
                  {pttBinding && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={async () => {
                        await desktopPtt.clearBinding();
                        setPttBinding(await desktopPtt.getBinding());
                      }}
                    >
                      Reset
                    </Button>
                  )}
                </div>
              </div>
            )}

            {nativeVoiceAvailable() && (
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <Label>Native Voice Engine</Label>
                  <p className="text-xs text-muted-foreground">
                    The desktop app's own audio engine: enhanced noise suppression and lower latency. Applies from your next call.
                  </p>
                </div>
                <Switch
                  checked={nativeVoice}
                  onCheckedChange={(v) => {
                    setNativeVoicePreferred(v);
                    setNativeVoice(v);
                  }}
                />
              </div>
            )}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
