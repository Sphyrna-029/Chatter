/**
 * The geometry itself was checked in Chromium — placeholder box against loaded
 * box, across portrait, landscape, panoramic and smaller-than-the-column
 * images, all zero shift. What is worth pinning down here is the rule that
 * produced it, since a wrong bound is invisible until an image is squashed or
 * the timeline moves again.
 */
import { describe, it, expect } from "vitest";
import { reservedBox, MESSAGE_IMAGE_MAX_H_REM } from "@/lib/mediaBox";

describe("reservedBox", () => {
  it("bounds width by the column, the image, and the height cap", () => {
    // 1200x900 stands 320px tall at 426.7px wide, so that is the binding limit.
    expect(reservedBox({ w: 1200, h: 900 })).toEqual({
      aspectRatio: "1200 / 900",
      width: `min(100%, 1200px, calc(${MESSAGE_IMAGE_MAX_H_REM}rem * 1.3333))`,
    });
  });

  it("keeps a tall image narrow rather than letting it run past the cap", () => {
    const box = reservedBox({ w: 800, h: 2400 })!;
    // A 1:3 image may only be a third of the cap wide, or it would overshoot it.
    expect(box.width).toBe(`min(100%, 800px, calc(${MESSAGE_IMAGE_MAX_H_REM}rem * 0.3333))`);
  });

  it("never enlarges an image past its own size", () => {
    // 200x120 would be allowed 533px by the height cap; its own width wins.
    const box = reservedBox({ w: 200, h: 120 })!;
    expect(box.width).toContain("200px");
  });

  it("carries the ratio so the height follows from the width", () => {
    expect(reservedBox({ w: 3000, h: 500 })!.aspectRatio).toBe("3000 / 500");
  });

  it("expresses the cap in rem, so it tracks the app's font scale", () => {
    expect(reservedBox({ w: 100, h: 100 })!.width).toContain("rem");
  });

  it("declines to reserve anything it cannot trust", () => {
    expect(reservedBox(undefined)).toBeUndefined();
    expect(reservedBox({ w: 0, h: 100 })).toBeUndefined();
    expect(reservedBox({ w: 100, h: 0 })).toBeUndefined();
    expect(reservedBox({ w: -5, h: 100 })).toBeUndefined();
    expect(reservedBox({ w: Number.NaN, h: 100 })).toBeUndefined();
    expect(reservedBox({ w: Number.POSITIVE_INFINITY, h: 100 })).toBeUndefined();
  });
});
