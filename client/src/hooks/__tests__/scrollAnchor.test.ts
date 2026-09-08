/**
 * The row search decides which message a timeline holds still while older
 * history loads above it. Everything else about that — the measuring, the
 * scroll correction — needs real layout, and jsdom reports zero for every
 * height and rect, so this covers the part that can be answered with numbers:
 * given rows at known positions, which one is the reader looking at.
 */
import { describe, it, expect } from "vitest";
import { firstVisibleRow } from "@/lib/scrollAnchor";

/** Rows 100px tall, stacked from `start`, as bottom edges. */
function stack(count: number, start = 0, height = 100) {
  return (i: number) => start + (i + 1) * height;
}

describe("firstVisibleRow", () => {
  it("finds the row straddling the top of the viewport", () => {
    // Rows end at 100, 200, ... 1000. A viewport top of 250 cuts row 2.
    expect(firstVisibleRow(10, stack(10), 250)).toBe(2);
  });

  it("takes the row below when the viewport starts exactly on an edge", () => {
    // Row 1 ends at 200 and is therefore no longer on screen at 200.
    expect(firstVisibleRow(10, stack(10), 200)).toBe(2);
  });

  it("returns the first row when the whole list is below the viewport", () => {
    expect(firstVisibleRow(10, stack(10), -500)).toBe(0);
  });

  it("returns -1 when every row is above the viewport", () => {
    expect(firstVisibleRow(10, stack(10), 5000)).toBe(-1);
  });

  it("handles an empty list", () => {
    expect(firstVisibleRow(0, () => 0, 0)).toBe(-1);
  });

  it("handles a single row from either side", () => {
    expect(firstVisibleRow(1, stack(1), 50)).toBe(0);
    expect(firstVisibleRow(1, stack(1), 150)).toBe(-1);
  });

  it("agrees with a linear scan across every offset", () => {
    const count = 64;
    const bottomOf = stack(count);
    for (let top = -50; top < 6500; top += 7) {
      let expected = -1;
      for (let i = 0; i < count; i++) {
        if (bottomOf(i) > top) { expected = i; break; }
      }
      expect(firstVisibleRow(count, bottomOf, top)).toBe(expected);
    }
  });

  it("measures a fraction of the rows it searches", () => {
    let reads = 0;
    const bottomOf = (i: number) => { reads++; return stack(1024)(i); };
    firstVisibleRow(1024, bottomOf, 51200);
    expect(reads).toBeLessThanOrEqual(11);
  });

  it("copes with rows of differing heights", () => {
    // A tall image message between two short ones.
    const bottoms = [40, 520, 560, 600];
    const bottomOf = (i: number) => bottoms[i];
    expect(firstVisibleRow(4, bottomOf, 0)).toBe(0);
    expect(firstVisibleRow(4, bottomOf, 100)).toBe(1);
    expect(firstVisibleRow(4, bottomOf, 540)).toBe(2);
  });
});
