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
