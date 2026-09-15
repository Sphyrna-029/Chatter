import { describe, it, expect } from "vitest";
import { formatBytes } from "@/lib/utils";

describe("formatBytes", () => {
  it("picks the unit the number is comfortable in", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(2 * 1024 * 1024)).toBe("2 MB");
    expect(formatBytes(8_412_773_120)).toBe("7.8 GB");
  });

  it("drops a trailing zero rather than writing 2.0 MB", () => {
    expect(formatBytes(1024)).toBe("1 KB");
  });

  it("answers for nothing, and for nonsense", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-1)).toBe("0 B");
  });

  it("stops at the largest unit it knows rather than running off the end", () => {
    expect(formatBytes(1024 ** 6)).toMatch(/TB$/);
  });
});
