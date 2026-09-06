/**
 * @vitest-environment jsdom
 *
 * Set per file rather than globally: every other suite here is pure logic and
 * runs faster without a DOM.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  composerLength,
  emojiImage,
  getComposerText,
  setComposerText,
} from "@/lib/composer";

/**
 * The composer's DOM form and its string form must be exact inverses. A draft
 * is saved as the string and restored into the DOM on another device, so any
 * asymmetry here shows up as a draft that changes when you pick it up.
 */

function composer(): HTMLDivElement {
  const div = document.createElement("div");
  document.body.appendChild(div);
  return div;
}

/** Write text in, read it back out — what saving and restoring a draft does. */
function roundTrip(text: string): string {
  const div = composer();
  setComposerText(div, text);
  return getComposerText(div);
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("composer round trip", () => {
  it("preserves plain text", () => {
    expect(roundTrip("hello there")).toBe("hello there");
  });

  it("preserves newlines", () => {
    expect(roundTrip("one\ntwo\nthree")).toBe("one\ntwo\nthree");
  });

  it("preserves a custom emoji marker", () => {
    const text = ":emoji{/external/party.png}:";
    expect(roundTrip(text)).toBe(text);
  });

  it("preserves emoji mixed with text and newlines", () => {
    const text = "nice :emoji{/external/a.png}: work\nsee you :emoji{/external/b.png}:";
    expect(roundTrip(text)).toBe(text);
  });

  it("preserves adjacent emoji with nothing between them", () => {
    const text = ":emoji{/a.png}::emoji{/b.png}:";
    expect(roundTrip(text)).toBe(text);
  });

  it("keeps an empty draft empty", () => {
    expect(roundTrip("")).toBe("");
  });

  it("does not treat a lone colon or brace as a marker", () => {
    const text = "ratio 3:1 and { braces } and :emoji without a url";
    expect(roundTrip(text)).toBe(text);
  });

  it("survives repeated restores", () => {
    // Switching channels back and forth re-runs this on the same text.
    const text = "a :emoji{/x.png}: b\nc";
    const div = composer();
    setComposerText(div, text);
    setComposerText(div, getComposerText(div));
    setComposerText(div, getComposerText(div));
    expect(getComposerText(div)).toBe(text);
  });
});

describe("setComposerText", () => {
  it("replaces previous contents rather than appending", () => {
    const div = composer();
    setComposerText(div, "first");
    setComposerText(div, "second");
    expect(getComposerText(div)).toBe("second");
  });

  it("renders a custom emoji as an image carrying its url", () => {
    const div = composer();
    setComposerText(div, ":emoji{/external/party.png}:");
    const img = div.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.dataset.emojiUrl).toBe("/external/party.png");
    // The alt is the marker, so copied text carries what the message would.
    expect(img!.alt).toBe(":emoji{/external/party.png}:");
  });
});

describe("composerLength", () => {
  it("counts a custom emoji as one character, not its url", () => {
    const div = composer();
    setComposerText(div, ":emoji{/external/a-very-long-file-name.png}:");
    expect(composerLength(div)).toBe(1);
  });

  it("counts text and newlines", () => {
    const div = composer();
    setComposerText(div, "ab\ncd");
    // Two characters, a line break, two more.
    expect(composerLength(div)).toBe(5);
  });

  it("is zero for an empty composer", () => {
    expect(composerLength(composer())).toBe(0);
  });
});

describe("getComposerText", () => {
  it("trims the trailing blank lines browsers leave behind", () => {
    const div = composer();
    div.appendChild(document.createTextNode("text"));
    div.appendChild(document.createElement("br"));
    div.appendChild(document.createElement("br"));
    expect(getComposerText(div)).toBe("text");
  });

  it("reads an emoji image inserted by the picker", () => {
    const div = composer();
    div.appendChild(document.createTextNode("hi "));
    div.appendChild(emojiImage("/external/wave.png"));
    expect(getComposerText(div)).toBe("hi :emoji{/external/wave.png}:");
  });

  it("is empty for a null element", () => {
    expect(getComposerText(null)).toBe("");
  });
});
