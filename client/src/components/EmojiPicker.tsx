import { useState, useMemo, useRef, useEffect, type ReactNode } from "react";
import { STANDARD_SHORTCODES } from "../lib/emojiShortcodes";

/** Check if a string is a custom emoji URL */
export function isCustomEmojiUrl(s: string): boolean {
  return s.startsWith("/") || s.startsWith("http");
}

/** Render a text string that may contain :emoji{url}: markers into React nodes */
export function renderInlineEmojis(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const regex = /:emoji\{([^}]+)\}:/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    parts.push(
      <img key={match.index} src={match[1]} alt="emoji" className="inline-block h-4 w-4 object-contain align-middle mx-0.5" />
    );
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return parts;
}

const emojiCategories: Record<string, string[]> = {
  Smileys: ["😀","😃","😄","😁","😆","😅","🤣","😂","🙂","🙃","😉","😊","😇","🥰","😍","🤩","😘","😗","😚","😙","🥲","😋","😛","😜","🤪","😝","🤑","🤗","🤭","🤫","🤔","😐","😑","😶","😏","😒","🙄","😬","🤥","😌","😔","😪","🤤","😴","😷","🤒","🤕","🤢","🤮","🤧","🥵","🥶","🥴","😵","🤯","🤠","🥳","🥸","😎","🤓","🧐","😕","😟","🙁","☹️","😮","😯","😲","😳","🥺","😦","😧","😨","😰","😥","😢","😭","😱","😖","😣","😞","😓","😩","😫","🥱","😤","😠","😡","🤬","😈","👿","💀","☠️","💩","🤡","👹","👺","👻","👽","👾","🤖"],
  Gestures: ["👍","👎","👊","✊","🤛","🤜","🤞","✌️","🤟","🤘","👌","🤌","🤏","👈","👉","👆","👇","☝️","🫵","👋","🤚","🖐️","✋","🖖","🫱","🫲","🫳","🫴","👏","🙌","🤲","🤝","🙏","✍️","💅","🤳","💪","🦾","🫀","🧠","👀","👁️","👅","👄","🫦","👣"],
  Hearts: ["❤️","🧡","💛","💚","💙","💜","🖤","🤍","🤎","🩷","🩵","🩶","💔","❤️‍🔥","❤️‍🩹","💕","💞","💓","💗","💖","💘","💝","💟","💌","💋","😻","💑","👫","👬","👭"],
  Animals: ["🐶","🐱","🐭","🐹","🐰","🦊","🐻","🐼","🐻‍❄️","🐨","🐯","🦁","🐮","🐷","🐸","🐵","🙈","🙉","🙊","🐔","🐧","🐦","🦆","🦅","🦉","🦇","🐺","🐗","🐴","🦄","🐝","🐛","🦋","🐌","🐞","🦟","🕷️","🦂","🐢","🐍","🦎","🐙","🦑","🦐","🦀","🐡","🐠","🐟","🐬","🐳","🦈","🐊","🐅","🐆","🦓","🐘","🦒","🦘","🦬","🐄","🐎","🐑","🦙","🐐","🦌","🐕","🐈","🪶","🦃","🦚","🦜","🦢","🐇","🦝","🦦","🦥","🐁","🐿️","🦔","🐾"],
  Nature: ["🌱","🌲","🌳","🌴","🌵","🌾","🌿","☘️","🍀","🍁","🍂","🍃","🍄","🌺","🌻","🌹","🥀","🌷","🌸","💐","🌼","🌰","⭐","🌟","✨","💫","⚡","🔥","🌊","💧","🌍","🌎","🌏","🏔️","🌋","🏝️","🌅","🌄","🌠","🌌","🌈","☀️","🌤️","⛅","☁️","🌧️","⛈️","🌩️","❄️","☃️","⛄","🌬️","🌀","☂️","🌫️"],
  Food: ["🍕","🍔","🍟","🌭","🍿","🥓","🥚","🍳","🥞","🍞","🥐","🧀","🥗","🌮","🌯","🥪","🍖","🍗","🥙","🧆","🍱","🍜","🍝","🍣","🍤","🥟","🍦","🍧","🍨","🍩","🍪","🎂","🍰","🧁","🍫","🍬","🍭","🍷","🍸","🍹","🍺","🥂","🥃","🧋","☕","🍵","🧃","🥛","🍾","🧊","🫖","🍎","🍊","🍋","🍇","🍓","🫐","🍑","🥭","🍍","🥥","🥝","🍅","🥑","🥦","🥕","🌽","🍆","🧅","🧄","🥔"],
  Activities: ["⚽","🏀","🏈","⚾","🥎","🎾","🏐","🏉","🥏","🎱","🏓","🏸","🥊","🥋","⛳","🏹","🛹","🛼","⛸️","🛷","🥌","🎿","🏂","🏋️","🤸","🏄","🏊","🚴","🧘","🧗","🏆","🥇","🥈","🥉","🎮","🎲","♟️","🎯","🎳","🧩","🎰","🎭","🎨","🎬","🎤","🎧","🎼","🎹","🥁","🎷","🎺","🎸","🎻","🪗","🎣","🤿","🪁","🎡","🎢","🎠","🎪"],
  Travel: ["🚗","🚕","🚙","🚌","🏎️","🚓","🚑","🚒","🚐","🛻","🚚","🚜","🏍️","🛵","🚲","🛴","✈️","🚀","🛸","🚁","⛵","🚢","🚂","🚇","🚉","🚊","🚝","⚓","🚦","🗺️","🗽","🗼","🏰","🏯","🏟️","⛩️","🏛️","⛪","🕌","🏠","🏡","🏢","🏥","🏦","🏨","🏪","🏫","🏬","🏭","🌁","🌃","🌆","🌇","🌉","🏙️"],
  Objects: ["📱","💻","⌨️","🖥️","🖱️","💾","💿","📷","📸","📹","🎥","📞","☎️","📺","📻","⏰","🔋","🔌","💡","🔦","🕯️","💸","💵","💳","💎","⚖️","🧲","🔧","🔨","🛠️","🔩","🔑","🗝️","🔐","🔒","🔓","🚪","🪑","🛋️","🛏️","🛁","🧴","🧹","🧺","🧻","🧼","🧽","🛒","🎁","🎀","🎊","🎉","🎈","🧨","🪄","🔮","💈","🪞","🛍️","📚","📖","✏️","🖊️","📝","📌","📎","✂️","🗑️","🔍","🔎","🔏","💊","🩺","🩹","🧬","🔭","📡","🧪","🧫","🧯","🛢️","⚗️"],
  Symbols: ["✅","❌","❓","❗","💯","🔴","🟠","🟡","🟢","🔵","🟣","⚫","⚪","🟤","🔶","🔷","🔸","🔹","🔺","🔻","♻️","⭕","🚫","⛔","📵","🔞","🔃","🔄","🔙","🔚","🔛","🔜","🔝","🏧","♿","💤","🔔","🔕","🎵","🎶","💱","💲","Ⓜ️","🅰️","🅱️","🆎","🆑","🅾️","🆘","🆒","🆓","🆕","🆖","🆗","🆙","🆚","🈺","🈷️","✴️","🌐","💠","🔱","📛","🔰","⚜️","🏁","🚩","🎌","🏴","🏳️"],
};

// Build a reverse map: emoji → shortcode names for searching
const emojiToNames: Record<string, string[]> = {};
for (const [name, emoji] of Object.entries(STANDARD_SHORTCODES)) {
  if (!emojiToNames[emoji]) emojiToNames[emoji] = [];
  emojiToNames[emoji].push(name);
}

interface EmojiPickerProps {
  onSelect: (emoji: string) => void;
  roomCustomEmojis?: string[];
  emojiAliases?: Record<string, string>;
}

export function EmojiPicker({ onSelect, roomCustomEmojis, emojiAliases }: EmojiPickerProps) {
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const query = search.toLowerCase().replace(/[_\s]/g, "");

  useEffect(() => {
    // Auto-focus the search input when the picker opens
    inputRef.current?.focus();
  }, []);

  // Build a reverse map from custom emoji value → alias names for searching
  const customEmojiToAliases = useMemo(() => {
    const map: Record<string, string[]> = {};
    if (emojiAliases) {
      for (const [name, value] of Object.entries(emojiAliases)) {
        if (!map[value]) map[value] = [];
        map[value].push(name);
      }
    }
    return map;
  }, [emojiAliases]);

  const filteredCategories = useMemo(() => {
    if (!query) return Object.entries(emojiCategories);
    return Object.entries(emojiCategories)
      .map(([cat, emojis]) => {
        const filtered = emojis.filter((e) => {
          const names = emojiToNames[e];
          const aliases = customEmojiToAliases[e];
          const allNames = [...(names || []), ...(aliases || [])];
          if (allNames.length === 0) return false;
          return allNames.some((n) => n.replace(/_/g, "").includes(query));
        });
        return [cat, filtered] as [string, string[]];
      })
      .filter(([, emojis]) => emojis.length > 0);
  }, [query, customEmojiToAliases]);

  const filteredCustomEmojis = useMemo(() => {
    if (!roomCustomEmojis || roomCustomEmojis.length === 0) return [];
    if (!query) return roomCustomEmojis;
    return roomCustomEmojis.filter((e) => {
      const aliases = customEmojiToAliases[e];
      if (!aliases || aliases.length === 0) return false;
      return aliases.some((n) => n.replace(/_/g, "").includes(query));
    });
  }, [query, roomCustomEmojis, customEmojiToAliases]);

  return (
    <div className="w-72 max-h-64 overflow-y-auto p-3">
      <div className="sticky top-0 bg-popover pb-2 z-10">
        <input
          ref={inputRef}
          type="text"
          placeholder="Search emoji..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full px-2 py-1 text-sm rounded border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>
      {filteredCustomEmojis.length > 0 && (
        <div className="mb-3">
          <p className="text-xs uppercase tracking-wider text-muted-foreground font-semibold mb-1">
            Room
          </p>
          <div className="grid grid-cols-8 gap-0.5">
            {filteredCustomEmojis.map((e) => (
              <button
                key={e}
                className="p-1 rounded hover:bg-accent transition-colors cursor-pointer hover:scale-110 flex items-center justify-center"
                onClick={() => onSelect(e)}
              >
                {e.startsWith("/") || e.startsWith("http") ? (
                  <img src={e} alt="emoji" className="w-6 h-6 object-contain" />
                ) : (
                  <span className="text-lg">{e}</span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
      {filteredCategories.map(([cat, emojis]) => (
        <div key={cat} className="mb-3">
          <p className="text-xs uppercase tracking-wider text-muted-foreground font-semibold mb-1">
            {cat}
          </p>
          <div className="grid grid-cols-8 gap-0.5">
            {emojis.map((e) => (
              <button
                key={e}
                className="p-1 text-lg rounded hover:bg-accent transition-colors cursor-pointer hover:scale-110"
                onClick={() => onSelect(e)}
              >
                {e}
              </button>
            ))}
          </div>
        </div>
      ))}
      {query && filteredCategories.length === 0 && filteredCustomEmojis.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-4">No emoji found</p>
      )}
    </div>
  );
}
