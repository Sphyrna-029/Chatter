/**
 * The sidebar's top-level arrangement.
 *
 * Two views read this — the rail and the expanded list — so the rules that
 * matter are the ones about what happens to things the stored order does not
 * mention: a room just joined, a folder just made, a room left behind in a
 * folder it no longer belongs to.
 */
import { describe, it, expect } from "vitest";
import {
  arrangeSidebar,
  orderWithMove,
  groupRoomsWithDrop,
  folderUnread,
} from "@/lib/sidebarOrder";
import type { RoomGroup } from "@/lib/api";

function group(id: string, position: number, roomIds: string[]): RoomGroup {
  return {
    group_id: id,
    name: id,
    position,
    collapsed: false,
    room_ids: roomIds,
  };
}

describe("arrangeSidebar", () => {
  it("follows the stored order, folders and rooms together", () => {
    const { entries, order } = arrangeSidebar(
      [group("g1", 0, ["r2"])],
      ["r1", "r2", "r3"],
      ["r3", "g1", "r1"],
    );
    expect(order).toEqual(["r3", "g1", "r1"]);
    expect(entries.map((e) => e.kind)).toEqual(["room", "group", "room"]);
  });

  it("puts a room a folder holds inside it, not at the top level", () => {
    const { order, entries } = arrangeSidebar(
      [group("g1", 0, ["r2"])],
      ["r1", "r2"],
      [],
    );
    expect(order).toEqual(["g1", "r1"]);
    const folder = entries.find((e) => e.kind === "group");
    expect(folder && folder.kind === "group" && folder.roomIds).toEqual(["r2"]);
  });

  it("falls back to folders by position then rooms as listed", () => {
    // What every client saw before an order was ever stored, so a user who
    // has never dragged anything sees no change.
    const { order } = arrangeSidebar(
      [group("g2", 1, []), group("g1", 0, [])],
      ["r1", "r2"],
      [],
    );
    expect(order).toEqual(["g1", "g2", "r1", "r2"]);
  });

  it("appends what the order does not name rather than dropping it", () => {
    // A room joined on another device, with an order this client stored
    // before it existed.
    const { order } = arrangeSidebar([], ["r1", "r2", "r3"], ["r3", "r1"]);
    expect(order).toEqual(["r3", "r1", "r2"]);
  });

  it("ignores an id for a folder or room that has gone", () => {
    const { order } = arrangeSidebar([], ["r1"], ["g_deleted", "r_left", "r1"]);
    expect(order).toEqual(["r1"]);
  });

  it("ignores a room a folder names that the user is no longer in", () => {
    // Leaving a room does not rewrite every folder that mentioned it, and a
    // folder must not offer a door to a room that cannot be opened.
    const { entries } = arrangeSidebar(
      [group("g1", 0, ["r1", "r_left"])],
      ["r1"],
      ["g1"],
    );
    const folder = entries.find((e) => e.kind === "group");
    expect(folder && folder.kind === "group" && folder.roomIds).toEqual(["r1"]);
  });

  it("draws an id the order names twice exactly once", () => {
    const { order } = arrangeSidebar([], ["r1", "r2"], ["r2", "r2", "r1"]);
    expect(order).toEqual(["r2", "r1"]);
  });
});

describe("orderWithMove", () => {
  it("moves an id before or after its target", () => {
    expect(orderWithMove(["a", "b", "c"], "c", "a", "before")).toEqual(["c", "a", "b"]);
    expect(orderWithMove(["a", "b", "c"], "a", "c", "after")).toEqual(["b", "c", "a"]);
  });

  it("places an id the list does not hold yet", () => {
    // Pulling a room out of a folder: the top level has never held it, and it
    // still has to land where the cursor was.
    expect(orderWithMove(["a", "b"], "x", "b", "before")).toEqual(["a", "x", "b"]);
  });

  it("appends when there is no target", () => {
    expect(orderWithMove(["a", "b"], "a", null, "before")).toEqual(["b", "a"]);
    expect(orderWithMove(["a"], "x", null, "after")).toEqual(["a", "x"]);
  });

  it("appends when the target is not in the list", () => {
    expect(orderWithMove(["a", "b"], "a", "gone", "before")).toEqual(["b", "a"]);
  });

  it("leaves the order alone when dropped on itself", () => {
    const order = ["a", "b"];
    expect(orderWithMove(order, "a", "a", "after")).toBe(order);
    expect(orderWithMove(order, "", "a", "after")).toBe(order);
  });
});

describe("groupRoomsWithDrop", () => {
  it("inserts a room at the position it was dropped", () => {
    expect(groupRoomsWithDrop(["a", "b"], "x", "a", "after")).toEqual(["a", "x", "b"]);
  });

  it("appends when the folder itself was the target", () => {
    expect(groupRoomsWithDrop(["a", "b"], "x", null, "after")).toEqual(["a", "b", "x"]);
  });

  it("reorders a room already in the folder", () => {
    expect(groupRoomsWithDrop(["a", "b", "c"], "c", "b", "before")).toEqual(["a", "c", "b"]);
  });
});

describe("folderUnread", () => {
  it("adds up the mentions of the rooms it is hiding", () => {
    const state = folderUnread(["r1", "r2"], { r1: 2, r2: 3 }, {}, null);
    expect(state).toEqual({ mentions: 5, unread: true });
  });

  it("reads as unread when a room has unread messages but no mention", () => {
    expect(folderUnread(["r1"], {}, { r1: 4 }, null)).toEqual({ mentions: 0, unread: true });
  });

  it("excludes the room being read, like a room row does", () => {
    expect(folderUnread(["r1", "r2"], { r1: 9 }, { r2: 1 }, "r1")).toEqual({
      mentions: 0,
      unread: true,
    });
    expect(folderUnread(["r1"], { r1: 9 }, { r1: 9 }, "r1")).toEqual({
      mentions: 0,
      unread: false,
    });
  });

  it("is quiet for an empty folder", () => {
    expect(folderUnread([], { r1: 1 }, { r1: 1 }, null)).toEqual({ mentions: 0, unread: false });
  });
});
