import { useCallback, useEffect, useState } from "react";

/**
 * The clipping defaults a user keeps in their profile, and a hook that keeps
 * every component holding them in step.
 *
 * These live in localStorage rather than on the server: arming a buffer costs
 * a second video encoder on *this* machine, so the answer can reasonably
 * differ between a desktop and a laptop.
 */

export const CLIP_LENGTH_OPTIONS = [15, 30, 60] as const;
export type ClipLength = (typeof CLIP_LENGTH_OPTIONS)[number];

export interface ClipSettings {
  /** Arm the buffer on whichever share is focused as the main stream. */
  autoArm: boolean;
  /** How much footage to keep behind the live edge. */
  lengthSecs: ClipLength;
}

const STORAGE_KEY = "chatter_clip_settings";
/** Superseded by STORAGE_KEY, still read once so an existing choice carries over. */
const LEGACY_LENGTH_KEY = "chatter_clip_length_secs";

export const DEFAULT_CLIP_SETTINGS: ClipSettings = {
  // Off until asked for: see the cost note on useClipBuffer.
  autoArm: false,
  lengthSecs: 30,
};

/** Dispatched on every write. `storage` only fires in *other* tabs, so without
 *  this the profile dialog and the clip controls drift apart until a reload. */
const CHANGE_EVENT = "clip-settings-change";

function isClipLength(value: unknown): value is ClipLength {
  return (CLIP_LENGTH_OPTIONS as readonly unknown[]).includes(value);
}

export function loadClipSettings(): ClipSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const stored = JSON.parse(raw) as Partial<ClipSettings>;
      return {
        autoArm: stored.autoArm === true,
        lengthSecs: isClipLength(stored.lengthSecs)
          ? stored.lengthSecs
          : DEFAULT_CLIP_SETTINGS.lengthSecs,
      };
    }
    const legacy = Number(localStorage.getItem(LEGACY_LENGTH_KEY));
    if (isClipLength(legacy)) {
      return { ...DEFAULT_CLIP_SETTINGS, lengthSecs: legacy };
    }
  } catch {
    // Storage can be unavailable outright; the defaults still work.
  }
  return DEFAULT_CLIP_SETTINGS;
}

export function storeClipSettings(settings: ClipSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // The preference just will not survive the reload.
  }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

export function useClipSettings() {
  const [settings, setSettings] = useState<ClipSettings>(loadClipSettings);

  useEffect(() => {
    const sync = () => setSettings(loadClipSettings());
    window.addEventListener(CHANGE_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(CHANGE_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  // Merged against what is on disk rather than against `settings`, so two
  // components editing different fields at once cannot clobber each other.
  const updateSettings = useCallback((updates: Partial<ClipSettings>) => {
    storeClipSettings({ ...loadClipSettings(), ...updates });
  }, []);

  return { settings, updateSettings };
}
