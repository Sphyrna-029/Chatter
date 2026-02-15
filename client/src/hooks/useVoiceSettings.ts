import { useState } from "react";

export type NoiseSuppressionMode = "none" | "browser";

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

export function useVoiceSettings() {
  const [settings, setSettingsState] = useState<VoiceSettings>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      return stored ? { ...DEFAULT_SETTINGS, ...JSON.parse(stored) } : DEFAULT_SETTINGS;
    } catch {
      return DEFAULT_SETTINGS;
    }
  });

  const updateSettings = (updates: Partial<VoiceSettings>) => {
    setSettingsState((prev) => {
      const next = { ...prev, ...updates };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  };

  return { settings, updateSettings };
}
