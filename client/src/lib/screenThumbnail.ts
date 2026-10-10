import { screenThumbnailsMap } from "@/lib/store";

/** One downscaled JPEG of a live screen share, as a `data:` URL.
 *
 *  The only place a frame of a share can be grabbed cheaply is the sharer's
 *  own tab: it holds the raw capture, while the server forwards the share as
 *  opaque RTP packets it never decodes and a viewer outside the call has no
 *  stream at all. So the sharer snapshots its own capture on a slow timer and
 *  posts it; everyone else reads it back. See `routes/screenshare.rs`.
 *
 *  A single hidden `<video>` element is reused across captures: a MediaStream
 *  only advances frames while it is attached to a playing element, and
 *  building a fresh one per snapshot would leak an element per tick. */
let captureElement: HTMLVideoElement | null = null;

/** Longest edge of the still. It is a hover peek, not the stream itself, so a
 *  couple hundred pixels is plenty and keeps the posted JPEG in the tens of
 *  kilobytes the server allows. */
const MAX_EDGE = 256;

/** JPEG quality. Low on purpose: it is a thumbnail shown at a few centimetres,
 *  and every byte is re-posted on the capture timer. */
const JPEG_QUALITY = 0.6;

/** Draw the current frame of `stream` to a small canvas and return it as a
 *  JPEG data URL, or `null` when there is no video track or no frame has
 *  decoded yet (a share that has just started). */
export function captureScreenThumbnail(stream: MediaStream): string | null {
  const videoTrack = stream.getVideoTracks()[0];
  if (!videoTrack) return null;

  if (!captureElement) {
    const element = document.createElement("video");
    element.muted = true;
    element.autoplay = true;
    element.playsInline = true;
    element.disablePictureInPicture = true;
    captureElement = element;
  }

  captureElement.srcObject = stream;
  try {
    captureElement.play().catch(() => {});
  } catch {
    // A live MediaStream is already advancing; play() is only to be sure.
  }

  const naturalWidth = captureElement.videoWidth;
  const naturalHeight = captureElement.videoHeight;
  if (!naturalWidth || !naturalHeight) return null;

  const scale = Math.min(1, MAX_EDGE / Math.max(naturalWidth, naturalHeight));
  const width = Math.max(1, Math.round(naturalWidth * scale));
  const height = Math.max(1, Math.round(naturalHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;

  context.drawImage(captureElement, 0, 0, width, height);
  return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
}

/** Replace the room's set of stills with the one the server just reported, so
 *  a share that stopped or a sharer who left drops out of the hover peek. */
export function syncScreenThumbnails(thumbnails: Record<string, string>) {
  screenThumbnailsMap.clear();
  for (const [sharer, thumbnail] of Object.entries(thumbnails)) {
    screenThumbnailsMap.set(sharer, thumbnail);
  }
}
