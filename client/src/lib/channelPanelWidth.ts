/**
 * How wide the channel column is, and where that answer is kept.
 *
 * The column sizes itself to its contents until the reader drags the handle,
 * at which point their width wins. That width used to live in the component,
 * which loses it on every room change: selecting a room empties `channels`,
 * the layout drops the column while it has nothing to show, and what comes
 * back is a new component measuring the new room from scratch. The reader
 * dragged a width and the app kept re-deciding it.
 *
 * So it is kept here instead, per browser. Per browser rather than per account
 * because a column width is about the window it is in — a laptop and a wide
 * monitor do not want the same one — which is the same reason the screen share
 * ceiling and the watch party volume live here rather than on the server.
 *
 * One width for every room, not one each: carrying it between rooms is the
 * whole point. A room with long channel names no longer widens the column
 * out from under a reader who has already said how wide they want it.
 */

const STORAGE_KEY = "chatter_channel_panel_width";

/** The widest the column may size itself to, and how narrow it may be dragged.
 *  The auto-measured floor is higher than the dragged one: measuring is the
 *  app's guess and should not produce something unusably narrow, while a
 *  reader asking for narrow means it. */
export const MIN_PANEL_WIDTH = 180;
export const MAX_PANEL_WIDTH = 400;
export const MIN_DRAG_WIDTH = 140;
/** Used until the first measurement, and if a canvas context is unavailable. */
export const DEFAULT_PANEL_WIDTH = 208;

/** A width the reader asked for, held to the draggable range. */
export function clampPanelWidth(px: number): number {
  if (!Number.isFinite(px)) return DEFAULT_PANEL_WIDTH;
  return Math.min(MAX_PANEL_WIDTH, Math.max(MIN_DRAG_WIDTH, Math.round(px)));
}

/**
 * The width this reader chose, or `null` if they never have.
 *
 * The difference matters: `null` is what lets the column go on measuring
 * itself per room, which is the behaviour anyone who has not touched the
 * handle already has. A chosen width is a decision, and it outranks the
 * measurement for every room.
 */
export function loadChannelPanelWidth(): number | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === null) return null;
    const px = Number.parseInt(stored, 10);
    if (!Number.isFinite(px) || px <= 0) return null;
    // Clamped on the way out as well as in: the limits can move between
    // releases, and a stored width outlives them.
    return clampPanelWidth(px);
  } catch {
    return null;
  }
}

/** `undefined` until storage has been read, then whatever it said. */
let chosen: number | null | undefined;

/**
 * The same answer as {@link loadChannelPanelWidth}, read from storage once.
 *
 * The column asks this while rendering and while deciding whether to measure
 * itself, and it is built again on every room change — so the question is
 * asked constantly and the answer only changes when someone drags. Holding it
 * here also means a drag survives a browser that refuses to store it: the
 * width lasts the session rather than the room.
 */
export function chosenChannelPanelWidth(): number | null {
  if (chosen === undefined) chosen = loadChannelPanelWidth();
  return chosen;
}

export function storeChannelPanelWidth(px: number): void {
  const width = clampPanelWidth(px);
  chosen = width;
  try {
    localStorage.setItem(STORAGE_KEY, String(width));
  } catch {
    // A browser refusing storage is not a reason to refuse the drag; the
    // width still holds for this session.
  }
}

/** Testing seam: drop what was read so the next call reads storage again. */
export function forgetChosenChannelPanelWidth(): void {
  chosen = undefined;
}
