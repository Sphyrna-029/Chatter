/**
 * Which URLs get answered with a `.preview.webp` and which are left alone.
 *
 * The rule is easy to state and easy to break by accident, because it is
 * driven by a filename suffix: anything that already *is* a derivative must
 * be asked for as itself.
 */
import { describe, it, expect } from "vitest";
import { toImagePreviewUrl } from "@/components/AuthImage";

describe("toImagePreviewUrl", () => {
  it("asks for the lightweight preview of an uploaded still", () => {
    expect(toImagePreviewUrl("https://host/external/abc/pic.png")).toBe(
      "https://host/external/abc/pic.png.preview.webp",
    );
  });

  it("keeps a query string on the end where the server expects it", () => {
    expect(toImagePreviewUrl("https://host/external/abc/pic.jpg?v=2")).toBe(
      "https://host/external/abc/pic.jpg.preview.webp?v=2",
    );
  });

  it("leaves a video thumbnail alone", () => {
    // The thumbnail is already downscaled, and it is generated on demand from
    // a request for the thumbnail itself — rewriting this one asks for a
    // preview of a file that may not exist yet, and gets a black box.
    const thumb = "https://host/external/abc/clip.mp4.thumb.jpg";
    expect(toImagePreviewUrl(thumb)).toBe(thumb);
  });

  it("leaves a preview alone rather than previewing it again", () => {
    const preview = "https://host/external/abc/pic.png.preview.webp";
    expect(toImagePreviewUrl(preview)).toBe(preview);
  });

  it("leaves animated and remote images alone", () => {
    const gif = "https://host/external/abc/loop.gif";
    expect(toImagePreviewUrl(gif)).toBe(gif);
    const remote = "https://media.giphy.com/media/abc/giphy.png";
    expect(toImagePreviewUrl(remote)).toBe(remote);
    expect(toImagePreviewUrl("")).toBe("");
  });
});
