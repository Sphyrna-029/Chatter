/**
 * Finding the message a scrolling timeline should hold still.
 *
 * The search is here rather than inline in the component because it is the one
 * part of holding a scroll position that can be checked without a browser: it
 * is asked for a row index, not for a scroll offset, and an off-by-one puts the
 * anchor on a row the reader cannot see.
 */

/**
 * Index of the first row still on screen — the first whose bottom edge falls
 * below the top of the viewport — or -1 if every row is above it.
 *
 * `bottomOf` is a callback rather than an array because the caller measures the
 * DOM, and measuring every row on every scroll event is the cost this binary
 * search exists to avoid. Rows must be in document order, which makes their
 * edges monotonic.
 */
export function firstVisibleRow(
  count: number,
  bottomOf: (index: number) => number,
  viewportTop: number,
): number {
  let lo = 0;
  let hi = count - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bottomOf(mid) > viewportTop) {
      found = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return found;
}
