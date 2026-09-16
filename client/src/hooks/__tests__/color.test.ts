/**
 * The hue a folder's wash is drawn in.
 *
 * Stability is the whole contract: the same folder has to come out the same
 * colour on every machine and after every reload, or a mark that means "these
 * rooms belong together" becomes one that means nothing.
 */
import { describe, it, expect } from "vitest";
import { hueFromId } from "@/lib/color";

describe("hueFromId", () => {
  it("is the same hue every time for the same id", () => {
    expect(hueFromId("g_abc")).toBe(hueFromId("g_abc"));
  });

  it("does not depend on where the id appeared", () => {
    // Nothing about insertion order may reach this: two clients list a user's
    // folders in whatever order the record holds them.
    const ids = ["g_one", "g_two", "g_three"];
    const forwards = ids.map(hueFromId);
    const backwards = [...ids].reverse().map(hueFromId).reverse();
    expect(forwards).toEqual(backwards);
  });

  it("answers a degree on the wheel", () => {
    for (const id of ["", "g", "g_abc", "a".repeat(200), "🙂 folder"]) {
      const hue = hueFromId(id);
      expect(Number.isInteger(hue)).toBe(true);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });

  it("spreads ids across the wheel rather than clustering them", () => {
    // Folder ids share a prefix and differ in random tail, which is the case
    // a weak hash smears into one colour.
    const hues = new Set(
      Array.from({ length: 60 }, (_, i) => hueFromId(`g_${i}aBcD`)),
    );
    expect(hues.size).toBeGreaterThan(50);
  });
});
