import { useSyncExternalStore } from "react";

/** "rnnoise" is the desktop app's ML noise suppression (native voice only). */
export type NoiseSuppressionMode = "none" | "browser" | "rnnoise";

export interface VoiceSettings {
  inputDeviceId: string;
  outputDeviceId: string;
  echoCancellation: boolean;
  noiseSuppressionMode: NoiseSuppressionMode;
  autoGainControl: boolean;
  inputGainDb: number;
  inputVolume: number;
  outputVolume: number;
  inputMode: "open" | "ptt";
}

const STORAGE_KEY = "chatter_voice_settings";

const DEFAULT_SETTINGS: VoiceSettings = {
  inputDeviceId: "default",
  outputDeviceId: "default",
  echoCancellation: true,
  noiseSuppressionMode: "browser",
  autoGainControl: true,
  inputGainDb: 0,
  inputVolume: 100,
  outputVolume: 100,
  inputMode: "open",
};

function read(): VoiceSettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? { ...DEFAULT_SETTINGS, ...JSON.parse(stored) } : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

// One copy for the whole page. Each hook used to keep its own, so a change in
// the settings dialog never reached the call already running: the device,
// volumes and gain were saved and then ignored until the next page load.
let current: VoiceSettings = typeof window === "undefined" ? DEFAULT_SETTINGS : read();
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((l) => l());
}

// Another tab changing them is the same person changing them.
function onStorage(e: StorageEvent): void {
  if (e.key !== STORAGE_KEY) return;
  current = read();
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("storage", onStorage);
  };
}

export function getVoiceSettings(): VoiceSettings {
  return current;
}

export function updateVoiceSettings(updates: Partial<VoiceSettings>): void {
  current = { ...current, ...updates };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    // Still applies for this page; only remembering it is lost.
  }
  emit();
}

/** Linear gain to apply to the mic: input volume, plus manual gain when AGC is off. */
export function micGain(settings: VoiceSettings): number {
  const manual = settings.autoGainControl ? 1 : Math.pow(10, settings.inputGainDb / 20);
  return (settings.inputVolume / 100) * manual;
}

export function useVoiceSettings() {
  const settings = useSyncExternalStore(subscribe, getVoiceSettings, () => DEFAULT_SETTINGS);
  return { settings, updateSettings: updateVoiceSettings };
}
