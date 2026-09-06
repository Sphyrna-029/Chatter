/**
 * What Chatter sounds like.
 *
 * Every effect the app plays goes through here, for two reasons. A room can
 * ship its own pack, so the URL for an event is not a constant any more — it
 * depends on which room you are in. And a listener can turn the whole lot down
 * or off, which only works if there is one place that honours the setting.
 *
 * Sounds are best-effort throughout. A browser that has not been interacted
 * with yet refuses to play audio at all, and that must never surface as an
 * error: the sound is the garnish, not the event.
 */

/** The effects a room's pack can replace. Keep in sync with PACK_EVENTS in backend/sounds.rs. */
export type SoundEvent = "mention" | "voice-join" | "voice-leave" | "mute" | "unmute";

/** A room's overrides: event name -> `/external/...` URL. */
export type SoundPack = Partial<Record<SoundEvent, string>>;

/**
 * What plays when a room has said nothing.
 *
 * `voice-leave` has no file of its own: the built-in leave sound is the join
 * sound played backwards, which is why it is derived at runtime rather than
 * shipped. A pack that overrides it is played normally.
 */
const BUILT_IN: Record<SoundEvent, string | null> = {
  mention: "/external/vc-join.wav",
  "voice-join": "/external/vc-join.wav",
  "voice-leave": null,
  mute: "/external/mute.wav",
  unmute: "/external/unmute.wav",
};

/**
 * Per-event loudness, relative to the listener's master volume.
 *
 * Mute and unmute fire on your own keypress and can fire many times a minute,
 * so they have always been mixed well below the others. That is a property of
 * the sound rather than of any one call site, so it lives here — and it
 * applies to a room's replacement too, or a pack could undo it.
 */
const EVENT_GAIN: Record<SoundEvent, number> = {
  mention: 1,
  "voice-join": 1,
  "voice-leave": 1,
  mute: 0.3,
  unmute: 0.3,
};

/** The longest a chosen sound may run. Mirrors MAX_SOUND_SECS in
 *  backend/sounds.rs, which is the authority — this is only for the hint
 *  shown next to the picker. */
export const MAX_SOUND_SECS = 5;

const SETTINGS_KEY = "chatter_sound_settings";

export interface SoundSettings {
  /** Master switch for every effect, including entrance stings. */
  enabled: boolean;
  /** 0–1, applied to every sound this module plays. */
  volume: number;
}

export const DEFAULT_SOUND_SETTINGS: SoundSettings = { enabled: true, volume: 0.7 };

export function loadSoundSettings(): SoundSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SOUND_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<SoundSettings>;
    return {
      enabled: parsed.enabled ?? DEFAULT_SOUND_SETTINGS.enabled,
      // Clamp rather than trust: a stored value out of range would either be
      // silent or painfully loud, and neither is recoverable from in the UI.
      volume: clampVolume(parsed.volume ?? DEFAULT_SOUND_SETTINGS.volume),
    };
  } catch {
    return DEFAULT_SOUND_SETTINGS;
  }
}

export function saveSoundSettings(settings: SoundSettings) {
  try {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ ...settings, volume: clampVolume(settings.volume) }),
    );
  } catch {
    // Private browsing: the setting holds for this session only.
  }
}

function clampVolume(volume: number): number {
  if (!Number.isFinite(volume)) return DEFAULT_SOUND_SETTINGS.volume;
  return Math.min(1, Math.max(0, volume));
}

/** The URL an event resolves to for a given room, or null for the derived
 *  reversed-join leave sound. */
export function resolveSound(event: SoundEvent, pack?: SoundPack): string | null {
  const override = pack?.[event]?.trim();
  if (override) return override;
  return BUILT_IN[event];
}

// ─── The reversed leave sound ────────────────────────────────────────────────

/** Decoded once and reused: reversing a buffer per leave would be audible. */
let reversedJoinBuffer: AudioBuffer | null = null;
let reversingInFlight = false;

async function getReversedJoinBuffer(): Promise<AudioBuffer | null> {
  if (reversedJoinBuffer) return reversedJoinBuffer;
  if (reversingInFlight) return null;
  reversingInFlight = true;
  try {
    const ctx = new AudioContext();
    const response = await fetch(BUILT_IN["voice-join"]!);
    const buffer = await ctx.decodeAudioData(await response.arrayBuffer());
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      buffer.getChannelData(c).reverse();
    }
    reversedJoinBuffer = buffer;
    await ctx.close();
    return reversedJoinBuffer;
  } catch {
    // Let a later leave try again.
    reversingInFlight = false;
    return null;
  }
}

/** Warm the reversed buffer so the first leave is not silent while it decodes. */
export function prewarmSounds() {
  void getReversedJoinBuffer();
}

async function playReversedJoin(volume: number) {
  const buffer = await getReversedJoinBuffer();
  if (!buffer) return;
  try {
    const ctx = new AudioContext();
    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    gain.gain.value = volume;
    source.buffer = buffer;
    source.connect(gain);
    gain.connect(ctx.destination);
    source.start();
    source.onended = () => void ctx.close();
  } catch {
    // Autoplay policy, or no audio device.
  }
}

// ─── Playback ────────────────────────────────────────────────────────────────

/** Play an arbitrary sound file, honouring the listener's settings. */
export function playSoundUrl(url: string, gain = 1) {
  if (!url) return;
  const settings = loadSoundSettings();
  if (!settings.enabled || settings.volume === 0) return;
  try {
    const audio = new Audio(url);
    audio.volume = clampVolume(settings.volume * gain);
    void audio.play().catch(() => {});
  } catch {
    // Nothing to recover: a sound that will not play is not an error.
  }
}

/**
 * Play one of the app's effects, using the room's pack where it has one.
 *
 * `pack` is the room's overrides — pass `roomInfo.sounds`. Omitting it plays
 * the built-in sound, which is right for anything not scoped to a room.
 */
export function playSound(event: SoundEvent, pack?: SoundPack) {
  const settings = loadSoundSettings();
  if (!settings.enabled || settings.volume === 0) return;

  const gain = EVENT_GAIN[event];
  const url = resolveSound(event, pack);
  if (url === null) {
    void playReversedJoin(clampVolume(settings.volume * gain));
    return;
  }
  playSoundUrl(url, gain);
}
