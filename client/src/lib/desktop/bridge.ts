// The Chatter desktop app loads this client from the server, like a browser
// does, and adds `window.chatterDesktop` before the page runs. In a browser it
// is absent, `desktop` is null, and every caller below falls back to what the
// web client has always done.
//
// Contract rules (Chatter-Desktop type-checks its implementation against this
// file, so it is the source of truth):
//   - Additive only. Never rename or repurpose a field or a feature string.
//   - Check `hasDesktopFeature()` before using anything beyond the base fields.
//     This client updates on every server deploy, but installed desktop apps
//     lag behind, so a newer client must cope with an older app.

/** A key (or mouse button) the desktop app watches system-wide. */
export interface PttBinding {
  /** Human-readable, for display only — e.g. "Ctrl + `" or "Mouse 4". */
  label: string;
  /** Opaque to the client; the desktop app interprets it. */
  code: string;
}

/** feature "ptt": push-to-talk that works while Chatter isn't focused. */
export interface DesktopPushToTalk {
  /** Called on every press (true) and release (false). Returns an unsubscribe. */
  subscribe(listener: (down: boolean) => void): () => void;
  getBinding(): Promise<PttBinding | null>;
  /** Waits for the next key or button the user presses, saves it, returns it.
   *  Resolves null if they cancel. */
  captureBinding(): Promise<PttBinding | null>;
  clearBinding(): Promise<void>;
}

/** feature "game-activity": the game the desktop app sees running, if the
 *  person lets it share that. */
export interface DesktopGameActivity {
  current(): Promise<string | null>;
  subscribe(listener: (game: string | null) => void): () => void;
}

/** feature "ducking": lower other apps' sound while people in the call
 *  talk. `amount` is 0 (off) to 1 (silence them). */
export interface DesktopDucking {
  get(): Promise<number>;
  set(amount: number): Promise<void>;
}

/** The desktop app's own preferences. They belong to this computer, not the
 *  account, so they are kept by the app rather than the server. */
export interface DesktopAppSettings {
  /** Open Chatter when the person signs in to their computer. */
  startWithSystem: boolean;
  /** Opened that way, stay in the tray instead of showing the window. */
  startMinimized: boolean;
  /** Show the game being played next to their name. */
  shareGameActivity: boolean;
  /** Programs added as games, beyond the ones the app recognises itself. */
  extraGames: { exe: string; name: string }[];
  /** Download and install updates automatically. */
  autoUpdate: boolean;
}

/** feature "desktop-settings": the desktop app's settings, drawn in the
 *  client's own UI rather than in a window of the app's. */
export interface DesktopSettings {
  get(): Promise<DesktopAppSettings>;
  /** Saves the fields given and returns the settings as they now stand. */
  set(update: Partial<DesktopAppSettings>): Promise<DesktopAppSettings>;
  /** Programs running now, to offer as games to add. */
  runningApps(): Promise<{ exe: string; name: string }[]>;
  /** Leave this server for the app's server picker. */
  changeServer(): void;
  /** Check for an update now; the app reports the result itself. */
  checkForUpdates(): void;
  /** Show the app's log files, for a bug report. */
  openLogs(): void;
  /** The app wants these settings shown (its tray menu's "Settings…").
   *  Returns an unsubscribe; while nothing listens the app opens its own. */
  onOpenRequest(listener: () => void): () => void;
}

export interface ChatterDesktopBridge {
  bridgeVersion: number;
  appVersion: string;
  platform: string;
  /** Feature strings the installed app supports, e.g. "ptt", "voice-backend@1". */
  features: readonly string[];
  pushToTalk?: DesktopPushToTalk;
  /** feature "voice-backend@1": the native voice engine (see lib/media). */
  voiceBackend?: (apiVersion: 1) => unknown;
  /** feature "app-audio@1": screen capture whose audio comes from the shared
   *  app (or everything but Chatter) rather than the browser's loopback. */
  displayCapture?: (apiVersion: 1) => unknown;
  gameActivity?: DesktopGameActivity;
  ducking?: DesktopDucking;
  settings?: DesktopSettings;
}

declare global {
  interface Window {
    chatterDesktop?: ChatterDesktopBridge;
  }
}

export const desktop: ChatterDesktopBridge | null =
  typeof window !== "undefined" && window.chatterDesktop ? window.chatterDesktop : null;

export function hasDesktopFeature(feature: string): boolean {
  return !!desktop?.features.includes(feature);
}
