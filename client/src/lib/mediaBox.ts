/**
 * Holding an image's space in a message before the image has loaded.
 *
 * Lives here rather than beside the markup because the sizing rule is the part
 * worth checking: it decides the geometry of every attachment in the timeline,
 * and getting it wrong either squashes pictures or fails to reserve anything —
 * both of which look like a bug in the scrolling rather than in a stylesheet.
 */

/** Matches the `max-h-80` message images are capped at. In rem rather than px
 *  because the app scales its root font size, which moves the cap with it. */
export const MESSAGE_IMAGE_MAX_H_REM = 20;

export interface MediaDimensions {
  w: number;
  h: number;
}

/**
 * The size an image will occupy, expressed so the browser can apply it before
 * the image arrives.
 *
 * The obvious approach — width and height attributes — reserves a box, but the
 * wrong one: an attribute width is a *used* width, so when `max-height` clamps
 * a tall image the width has nothing left to give and the picture is squashed.
 * Only a replaced element with `width: auto` shrinks both axes together, and
 * one with `width: auto` reserves nothing at all.
 *
 * So the height cap is restated as a bound on width, the axis that can shrink
 * while keeping the shape: the narrowest of the column, the image's own size,
 * and the width at which it would stand exactly `max-h-80` tall. The ratio
 * alongside it settles the height, and the box comes out the same before and
 * after the image loads.
 *
 * Returns undefined when nothing is known about the image, leaving it to size
 * itself as it always has.
 */
/** The caps a video thumbnail is rendered under, matching the classes on it. */
export const THUMBNAIL_MAX_W_PX = 640;
export const THUMBNAIL_MAX_H_PX = 480;

/**
 * The same rule for a video's thumbnail, and the fix for a black box beside it.
 *
 * The thumbnail sits in a shrink-to-fit container with a dark background, and a
 * replaced element contributes its *intrinsic* width to that container —
 * `max-height` does not feed back into the calculation. So a thumbnail taller
 * than the cap was drawn narrow inside a box still the full 640 wide, and the
 * background showed to the right of it: a portrait video rendered 270px of
 * picture against 370px of black, while a landscape one, never reaching the
 * cap, looked perfect. Giving the image a width the container can agree with
 * settles both.
 *
 * The video's own width is not a bound here the way an image's is. Thumbnails
 * are generated at exactly `THUMBNAIL_MAX_W_PX` across whatever the source
 * resolution, so that is already the widest it can be drawn without upscaling.
 */
export function thumbnailBox(dims: MediaDimensions | undefined) {
  if (!dims) return undefined;
  const { w, h } = dims;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return undefined;
  const ratio = (w / h).toFixed(4);
  return {
    aspectRatio: `${w} / ${h}`,
    width: `min(100%, ${THUMBNAIL_MAX_W_PX}px, calc(${THUMBNAIL_MAX_H_PX}px * ${ratio}))`,
  };
}

export function reservedBox(dims: MediaDimensions | undefined) {
  if (!dims) return undefined;
  const { w, h } = dims;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return undefined;
  const ratio = (w / h).toFixed(4);
  return {
    aspectRatio: `${w} / ${h}`,
    width: `min(100%, ${w}px, calc(${MESSAGE_IMAGE_MAX_H_REM}rem * ${ratio}))`,
  };
}
