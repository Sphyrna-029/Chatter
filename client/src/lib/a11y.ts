import type { KeyboardEvent } from "react";

/**
 * Props that make a non-button element behave like one.
 *
 * Several rows in this app must stay `<div>`s — a `<button>` cannot legally
 * contain the block content they hold, and their flex layouts depend on it.
 * Without these they are mouse-only: not focusable, not reachable by keyboard,
 * and announced as plain text by a screen reader.
 *
 *     <div {...clickable(() => selectChannel(id), `Open #${name}`)} className="...">
 */
export function clickable(onActivate: () => void, label?: string) {
  return {
    role: "button",
    tabIndex: 0,
    "aria-label": label,
    onClick: onActivate,
    onKeyDown: (e: KeyboardEvent) => {
      // Enter and Space are what a real button responds to; Space would
      // otherwise scroll the page.
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onActivate();
      }
    },
  };
}
