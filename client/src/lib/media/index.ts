// Which media stack voice runs on. In a browser it is always the browser's.
// The desktop app can offer a native engine (feature "voice-backend@1"); it is
// used unless the person has switched it off in Voice & Audio settings.

import { desktop, hasDesktopFeature } from "@/lib/desktop/bridge";
import { browserVoiceBackend } from "./browserVoice";
import type { DisplayCaptureBackend, VoiceMediaBackend } from "./types";

export type * from "./types";
export { browserVoiceBackend } from "./browserVoice";

const NATIVE_VOICE_KEY = "chatter_native_voice";

export function nativeVoiceAvailable(): boolean {
  return hasDesktopFeature("voice-backend@1") && typeof desktop?.voiceBackend === "function";
}

export function nativeVoicePreferred(): boolean {
  try {
    return localStorage.getItem(NATIVE_VOICE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setNativeVoicePreferred(on: boolean): void {
  try {
    localStorage.setItem(NATIVE_VOICE_KEY, on ? "on" : "off");
  } catch {
    // Only costs remembering the choice.
  }
}

const browserDisplayCapture: DisplayCaptureBackend = {
  getDisplayMedia: (options) => navigator.mediaDevices.getDisplayMedia(options),
};

/** The desktop app's screen capture when it offers one (feature
 *  "app-audio@1"): the picker there chooses the audio too. */
export function selectDisplayCapture(): DisplayCaptureBackend {
  if (hasDesktopFeature("app-audio@1") && typeof desktop?.displayCapture === "function") {
    try {
      const capture = desktop.displayCapture(1) as DisplayCaptureBackend | null;
      if (capture) return capture;
    } catch {
      // Fall back to the browser's.
    }
  }
  return browserDisplayCapture;
}

/** Chosen once per join, so a call never switches stacks underneath itself. */
export function selectVoiceBackend(): VoiceMediaBackend {
  if (nativeVoiceAvailable() && nativeVoicePreferred()) {
    try {
      const native = desktop!.voiceBackend!(1) as VoiceMediaBackend | null;
      if (native) return native;
    } catch {
      // An engine that can't start leaves voice on the browser.
    }
  }
  return browserVoiceBackend;
}
