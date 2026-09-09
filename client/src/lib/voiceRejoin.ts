/**
 * Whether a call survives the socket that was carrying it.
 *
 * The server drops a member from their voice channel the moment their
 * connection does, so a client coming back is always rejoining rather than
 * resuming. Keeping the decision pure makes the rule testable without a
 * browser, a socket, or a call.
 */

/** How long a call survives a dead socket.
 *
 * Under this, a drop is a blip and the call is worth putting back together.
 * Over it, the room has carried on without them — everyone else watched them
 * leave a minute ago — so reappearing unannounced, with a live microphone, is
 * not the reconnect they would have asked for. */
export const VOICE_REJOIN_GRACE_MS = 60_000;

export type VoiceRejoinDecision =
  /** Put the call back together on the new socket. */
  | "rejoin"
  /** Gone too long: drop the local half and let them walk back in themselves. */
  | "release"
  /** Not in a call to begin with, so there is nothing to do either way. */
  | "nothing-to-restore";

export function decideVoiceRejoin(session: {
  /** What the client still believes, which the server may already disagree with. */
  inVoiceChannel: boolean;
  voiceRoomId: string | null;
  /** How long the socket was down, in ms. */
  downForMs: number;
}): VoiceRejoinDecision {
  // Never joined, or left deliberately while the socket was down.
  if (!session.inVoiceChannel || !session.voiceRoomId) return "nothing-to-restore";
  // Exactly the grace period still counts as a blip; past it does not.
  return session.downForMs > VOICE_REJOIN_GRACE_MS ? "release" : "rejoin";
}

/** The parts of a call that belong to the person, not the channel. */
export interface VoiceRestoreState {
  muted: boolean;
  deafened: boolean;
}

/** How long a persisted call is worth restoring after a refresh. */
export const VOICE_SESSION_TTL_MS = 30_000;

/** A call, written down so a refresh can put it back as it was left. */
export interface StoredVoiceSession {
  roomId: string;
  channelId: string | null;
  muted: boolean;
  deafened: boolean;
  timestamp: number;
}

/**
 * Read back a persisted call, or null when there is nothing worth restoring.
 *
 * Mute and deafen are part of it because a refresh throws away the running
 * state they otherwise live in, and rejoining a call unmuted is the one way of
 * being wrong here that a person cannot see and would not forgive. An entry
 * written before those fields existed restores as unmuted, which is what it
 * did anyway; entries only live `VOICE_SESSION_TTL_MS`, so none survive long.
 */
export function parseStoredVoiceSession(
  raw: string | null,
  nowMs: number,
): StoredVoiceSession | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const session = parsed as Record<string, unknown>;
  if (typeof session.roomId !== "string" || session.roomId.length === 0) return null;
  if (typeof session.timestamp !== "number" || !Number.isFinite(session.timestamp)) return null;
  if (nowMs - session.timestamp > VOICE_SESSION_TTL_MS) return null;

  return {
    roomId: session.roomId,
    channelId: typeof session.channelId === "string" ? session.channelId : null,
    muted: session.muted === true,
    deafened: session.deafened === true,
    timestamp: session.timestamp,
  };
}
