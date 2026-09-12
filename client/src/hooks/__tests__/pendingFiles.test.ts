import { describe, it, expect } from "vitest";
import { planStaging, MAX_ATTACHMENTS } from "@/hooks/usePendingFiles";

describe("planStaging", () => {
  it("takes a whole batch that fits", () => {
    expect(planStaging(0, 10, MAX_ATTACHMENTS)).toEqual({ accepted: 10, rejected: 0 });
  });

  it("takes a batch one file at a time or all at once alike", () => {
    // The bug this replaced: ten separate calls each saw an empty row, so all
    // ten passed a check that only ever let four through.
    let staged = 0;
    for (let i = 0; i < 10; i++) {
      staged += planStaging(staged, 1, 4).accepted;
    }
    expect(staged).toBe(4);
    expect(planStaging(0, 10, 4)).toEqual({ accepted: 4, rejected: 6 });
  });

  it("reports the overflow rather than swallowing it", () => {
    expect(planStaging(0, 14, MAX_ATTACHMENTS)).toEqual({ accepted: 10, rejected: 4 });
  });

  it("fills the remaining room when the row is part full", () => {
    expect(planStaging(7, 5, MAX_ATTACHMENTS)).toEqual({ accepted: 3, rejected: 2 });
  });

  it("takes nothing once the row is full", () => {
    expect(planStaging(MAX_ATTACHMENTS, 3, MAX_ATTACHMENTS)).toEqual({ accepted: 0, rejected: 3 });
  });

  it("never returns a negative count if the row somehow overflowed", () => {
    expect(planStaging(12, 2, MAX_ATTACHMENTS)).toEqual({ accepted: 0, rejected: 2 });
  });

  it("handles an empty batch", () => {
    expect(planStaging(0, 0, MAX_ATTACHMENTS)).toEqual({ accepted: 0, rejected: 0 });
  });
});
