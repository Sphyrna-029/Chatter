/**
 * The geometry of a spatial voice channel.
 *
 * The room is a unit square — both axes 0..1 — so it has no pixel size the
 * server, the map and the audio graph would all have to agree on. This file
 * turns that into the one thing WebAudio understands: metres.
 *
 * The SFU forwards, it does not mix, so every listener already receives each
 * speaker as their own track. Panning is therefore entirely a client-side
 * concern and costs the server nothing — it never learns who can hear whom.
 */

/** How many metres across the room is. Everything below is in these units. */
export const ROOM_SIZE = 10;

/**
 * Distance model, tuned on the unit square above.
 *
 * `inverse` with these numbers gives full volume within arm's reach, about
 * three quarters at a fifth of the room, and roughly a sixth at the far
 * corner — quiet enough to hold a separate conversation, loud enough that the
 * room never feels empty. A model that reached silence would make the far half
 * of the floor useless.
 */
export const DISTANCE_MODEL = {
  refDistance: 1.5,
  rolloffFactor: 1,
  maxDistance: ROOM_SIZE * 1.5,
} as const;

/**
 * How quickly a panner follows a move, in seconds.
 *
 * Positions are stepped, not continuous — they arrive at drag rate, and a slot
 * can be handed to a different speaker between one packet and the next. Ramping
 * turns both into a slide instead of a click.
 */
export const GLIDE_SECONDS = 0.08;

/** A room point (0..1 on both axes) in the audio world's metres. */
export function toWorld(x: number, y: number): { x: number; y: number; z: number } {
  // Screen x is the audio x, so left on the floor is left in the ears. Screen y
  // becomes z — depth — because the floor is seen from above and the listener
  // faces into it. Audio y, height, is unused: nobody is standing on a chair.
  return { x: (x - 0.5) * ROOM_SIZE, y: 0, z: (y - 0.5) * ROOM_SIZE };
}

/** Distance between two room points, in the same metres. */
export function worldDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y) * ROOM_SIZE;
}

/**
 * Roughly how loud a source at `distance` metres comes through, 0..1.
 *
 * The same curve the browser applies, restated so the map can draw it. It is
 * only ever used to shade a ring — the audible truth is the PannerNode.
 */
export function distanceGain(distance: number): number {
  const { refDistance, rolloffFactor, maxDistance } = DISTANCE_MODEL;
  const d = Math.min(Math.max(distance, refDistance), maxDistance);
  return refDistance / (refDistance + rolloffFactor * (d - refDistance));
}

/** Move an AudioParam without a click, tolerating browsers that lack ramping. */
export function glide(param: AudioParam | undefined, value: number, now: number) {
  if (!param) return;
  try {
    param.setTargetAtTime(value, now, GLIDE_SECONDS);
  } catch {
    param.value = value;
  }
}
