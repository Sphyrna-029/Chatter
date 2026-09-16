/**
 * How the sidebar's top level is arranged, and what a drag does to it.
 *
 * Lives here rather than in `AppSidebar` because the arrangement is the part
 * worth checking and the part two views have to agree on: the rail draws
 * folders and loose rooms in one column, the expanded list draws the same
 * folders as sections above the same loose rooms, and a room that sits third
 * in one and first in the other is a bug nobody can see in a screenshot.
 *
 * The stored order is a flat list of ids that are each either a folder or a
 * room outside every folder. One list rather than a position on each, because
 * the two are dragged past one another — a folder sits *between* two rooms,
 * which two separate orderings cannot express.
 *
 * It is also deliberately partial. An id it does not name is not unplaced: it
 * falls to the end in the order it has always appeared in, so joining a room
 * or making a folder does not depend on the order being rewritten first, and
 * a client that has never dragged anything sees exactly what it saw before.
 */
import type { RoomGroup } from "@/lib/api";

/** One thing the top level draws: a room on its own, or a folder of rooms. */
export type SidebarEntry =
  | { kind: "room"; id: string }
  | { kind: "group"; id: string; group: RoomGroup; roomIds: string[] };

export interface SidebarArrangement {
  /** Folders and loose rooms, in the order they are drawn. */
  entries: SidebarEntry[];
  /** Every id in `entries`, which is what a reorder sends back. */
  order: string[];
}

/**
 * Arrange the top level from what the user has: their folders, the rooms they
 * are in, and the order they last left it in.
 *
 * `roomIds` is the rooms as the app already lists them (joined rooms, DMs
 * excluded) and is the fallback order — a room the stored order does not name
 * keeps the place it has always had relative to the others.
 *
 * A folder's rooms are narrowed to rooms in `roomIds`: leaving a room does not
 * rewrite every folder that mentioned it, so a folder can name rooms the user
 * is no longer in, and drawing those would offer a door to a room they cannot
 * open.
 */
export function arrangeSidebar(
  groups: RoomGroup[],
  roomIds: string[],
  order: string[],
): SidebarArrangement {
  const byGroupId = new Map(groups.map((g) => [g.group_id, g]));
  const grouped = new Set<string>();
  for (const group of groups) {
    for (const id of group.room_ids) grouped.add(id);
  }

  const loose = roomIds.filter((id) => !grouped.has(id));
  const looseSet = new Set(loose);

  const entryFor = (id: string): SidebarEntry | null => {
    const group = byGroupId.get(id);
    if (group) {
      return {
        kind: "group",
        id,
        group,
        roomIds: group.room_ids.filter((roomId) => roomIds.includes(roomId)),
      };
    }
    return looseSet.has(id) ? { kind: "room", id } : null;
  };

  const placed = new Set<string>();
  const entries: SidebarEntry[] = [];
  for (const id of order) {
    if (placed.has(id)) continue;
    const entry = entryFor(id);
    if (!entry) continue; // a folder since deleted, or a room since left
    placed.add(id);
    entries.push(entry);
  }

  // Whatever the order did not name, in the arrangement it had before there
  // was an order at all: folders by position, then rooms as the app lists them.
  const remainingGroups = [...groups]
    .filter((g) => !placed.has(g.group_id))
    .sort((a, b) => a.position - b.position);
  for (const group of remainingGroups) {
    const entry = entryFor(group.group_id);
    if (entry) {
      placed.add(group.group_id);
      entries.push(entry);
    }
  }
  for (const id of loose) {
    if (placed.has(id)) continue;
    placed.add(id);
    entries.push({ kind: "room", id });
  }

  return { entries, order: entries.map((entry) => entry.id) };
}

/**
 * Where a drop lands: the id being moved goes next to `targetId`, on the side
 * the cursor was on. A null target means the end of the list.
 *
 * Takes the moved id whether or not it is in the list already, because the two
 * cases are the same drag: pulling a room out of a folder places an id the top
 * level has never held, and both have to land exactly where the cursor was.
 */
export function orderWithMove(
  order: string[],
  movedId: string,
  targetId: string | null,
  side: "before" | "after",
): string[] {
  if (!movedId || movedId === targetId) return order;
  const without = order.filter((id) => id !== movedId);
  if (!targetId) return [...without, movedId];
  const at = without.indexOf(targetId);
  if (at === -1) return [...without, movedId];
  const insertAt = side === "before" ? at : at + 1;
  return [...without.slice(0, insertAt), movedId, ...without.slice(insertAt)];
}

/**
 * The rooms of a folder after a room is dropped into it next to `targetId`.
 *
 * `null` appends, which is what dropping on the folder icon itself means: no
 * room inside it was named, so the answer cannot be a position between two.
 */
export function groupRoomsWithDrop(
  roomIds: string[],
  movedId: string,
  targetId: string | null,
  side: "before" | "after",
): string[] {
  return orderWithMove(roomIds, movedId, targetId, side);
}

/** Unread state for a folder, which stands for rooms it is hiding. */
export function folderUnread(
  roomIds: string[],
  mentions: Record<string, number>,
  unreadCounts: Record<string, number>,
  currentRoomId: string | null,
): { mentions: number; unread: boolean } {
  let total = 0;
  let unread = false;
  for (const id of roomIds) {
    // The room being read drops its own badge in the expanded list, and a
    // folder holding it must not put the badge back.
    if (id === currentRoomId) continue;
    total += mentions[id] || 0;
    if ((unreadCounts[id] || 0) > 0) unread = true;
  }
  return { mentions: total, unread: unread || total > 0 };
}
