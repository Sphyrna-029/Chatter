import { useMemo, useRef, useState } from "react";
import { useAppContext } from "@/lib/store";
import { findMentionMatches, type MentionMatch } from "@/lib/mentions";

/** The "@word" the caret sits at the end of, or null. */
function searchAtCaret(el: HTMLTextAreaElement): string | null {
  if (el.selectionStart !== el.selectionEnd) return null;
  const before = el.value.slice(0, el.selectionStart);
  const match = /(?:^|\s)@(\w*)$/.exec(before);
  return match ? match[1] : null;
}

/**
 * @mention autocomplete for a plain `<textarea>` — the forum's composers. The
 * chat and thread composers are contenteditable and do this against the DOM
 * selection instead; all three draw their candidates from `findMentionMatches`
 * so none of them can offer a different list.
 *
 * The element is taken from the events rather than a ref, so it can sit on a
 * textarea that already has one, or none.
 */
export function useTextareaMentions(setValue: (value: string) => void) {
  const { state } = useAppContext();
  const [search, setSearch] = useState<string | null>(null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const elRef = useRef<HTMLTextAreaElement | null>(null);

  const matches: MentionMatch[] = useMemo(
    () => (search === null ? [] : findMentionMatches(state, search)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [search, state.roomMembers, state.customRoles, state.currentRoomId, state.roomInfoMap],
  );

  const detect = (el: HTMLTextAreaElement) => {
    elRef.current = el;
    setSearch(searchAtCaret(el));
    setSelectedIdx(0);
  };

  const complete = (name: string | undefined) => {
    const el = elRef.current;
    if (!name || !el) return;
    const caret = el.selectionStart;
    const at = el.value.lastIndexOf("@", caret - 1);
    if (at === -1) return;
    const insert = `@${name} `;
    const next = el.value.slice(0, at) + insert + el.value.slice(caret);
    setValue(next);
    setSearch(null);
    // A controlled value change puts the caret at the end; put it back after
    // what was inserted once React has written the new value.
    const pos = at + insert.length;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value);
    detect(e.target);
  };

  /** Handles the keys the menu owns. Returns true when it consumed one, so
   *  the caller's own Enter-to-send does not also fire. */
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (search === null || matches.length === 0) return false;
    elRef.current = e.currentTarget;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIdx((i) => Math.min(i + 1, matches.length - 1));
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(i - 1, 0));
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      complete(matches[selectedIdx]?.name);
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      // Closing the menu is all Escape means here — not cancelling an edit.
      e.stopPropagation();
      setSearch(null);
      return true;
    }
    return false;
  };

  return {
    open: search !== null && matches.length > 0,
    matches,
    selectedIdx,
    complete,
    onChange,
    onKeyDown,
    close: () => setSearch(null),
  };
}
