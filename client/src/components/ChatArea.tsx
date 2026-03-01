import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from "react";
import { useAppContext } from "@/lib/store";
import { apiUploadFile, apiSearchMessages, type MatrixMessage } from "@/lib/api";
import { STANDARD_SHORTCODES } from "@/lib/emojiShortcodes";
import { MessageItem } from "./MessageItem";
import { Search, X, ArrowDown, Image, Film, Music, FileText } from "lucide-react";
import { CommandBar } from "./CommandBar";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmojiPicker, renderInlineEmojis } from "./EmojiPicker";
import { GifPicker } from "./GifPicker";
import { displayUserId } from "@/lib/utils";

const MAX_MESSAGE_LENGTH = 4000;

interface ChatAreaProps {
  onJoinVoice?: () => void;
}

export function ChatArea({ onJoinVoice }: ChatAreaProps) {
  const { state, dispatch, sendMessage, sendTyping, updateTopic, loadOlderMessages } = useAppContext();
  const [input, setInput] = useState("");
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [gifOpen, setGifOpen] = useState(false);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionSearch, setMentionSearch] = useState("");
  const [mentionStart, setMentionStart] = useState(-1);
  const [selectedMentionIdx, setSelectedMentionIdx] = useState(0);
  const [emojiAutocompleteOpen, setEmojiAutocompleteOpen] = useState(false);
  const [emojiSearch, setEmojiSearch] = useState("");
  const [emojiStart, setEmojiStart] = useState(-1);
  const [selectedEmojiIdx, setSelectedEmojiIdx] = useState(0);
  const [editingTopic, setEditingTopic] = useState(false);
  const [topicDraft, setTopicDraft] = useState("");
  const topicInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollWrapperRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const prevScrollHeightRef = useRef<number>(0);
  const inputRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadFileName, setUploadFileName] = useState("");
  const [cliMode, setCliMode] = useState(false);
  const [displayLength, setDisplayLength] = useState(0);

  // Merge standard shortcodes + room emoji aliases (room overrides standard)
  const mergedShortcodes = useMemo(() => {
    const roomAliases = state.currentRoomId
      ? (state.roomInfoMap[state.currentRoomId]?.emoji_aliases ?? {})
      : {};
    return { ...STANDARD_SHORTCODES, ...roomAliases };
  }, [state.currentRoomId, state.roomInfoMap]);

  // --- Contenteditable helpers ---

  // Extract the text/emoji content from the contenteditable div.
  // Image emojis are replaced with their data-emoji-url attribute value.
  const getDivContent = (): string => {
    const div = inputRef.current;
    if (!div) return "";
    const walk = (node: Node): string => {
      let result = "";
      node.childNodes.forEach((child) => {
        if (child.nodeType === Node.TEXT_NODE) {
          result += child.textContent ?? "";
        } else if ((child as Element).tagName === "IMG") {
          const url = (child as HTMLImageElement).dataset.emojiUrl ?? "";
          result += `:emoji{${url}}:`;
        } else if ((child as Element).tagName === "BR") {
          result += "\n";
        } else {
          const tag = (child as Element).tagName;
          result += walk(child);
          if (tag === "DIV" || tag === "P") result += "\n";
        }
      });
      return result;
    };
    return walk(div).replace(/\n+$/, "");
  };

  // Count visible characters — each custom emoji counts as 1 character.
  const computeDisplayLength = (): number => {
    const div = inputRef.current;
    if (!div) return 0;
    let len = 0;
    const walk = (node: Node) => {
      node.childNodes.forEach((child) => {
        if (child.nodeType === Node.TEXT_NODE) {
          len += (child.textContent ?? "").length;
        } else if ((child as Element).tagName === "IMG") {
          len += 1;
        } else if ((child as Element).tagName === "BR") {
          len += 1;
        } else {
          walk(child);
          const tag = (child as Element).tagName;
          if (tag === "DIV" || tag === "P") len += 1;
        }
      });
    };
    walk(div);
    return len;
  };

  // Sync both input state and display length from the div content.
  const syncFromDiv = () => {
    setInput(getDivContent());
    setDisplayLength(computeDisplayLength());
  };

  // Insert a DOM node at the current cursor position inside the div.
  const insertAtCursor = (node: Node) => {
    const div = inputRef.current;
    if (!div) return;
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && div.contains(sel.getRangeAt(0).commonAncestorContainer)) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(node);
      const newRange = document.createRange();
      newRange.setStartAfter(node);
      newRange.collapse(true);
      sel.removeAllRanges();
      sel.addRange(newRange);
    } else {
      div.appendChild(node);
      const range = document.createRange();
      range.selectNodeContents(div);
      range.collapse(false);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    }
  };

  // Find the Range at a text-character offset within the div (ignores img/br).
  const findRangeAtOffset = (div: HTMLElement, targetOffset: number): Range | null => {
    let pos = 0;
    const range = document.createRange();
    const walk = (node: Node): boolean => {
      if (node.nodeType === Node.TEXT_NODE) {
        const len = (node.textContent ?? "").length;
        if (pos + len >= targetOffset) {
          range.setStart(node, targetOffset - pos);
          range.collapse(true);
          return true;
        }
        pos += len;
      } else {
        for (const child of Array.from(node.childNodes)) {
          if (walk(child)) return true;
        }
      }
      return false;
    };
    return walk(div) ? range : null;
  };

  // Search state
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchFilter, setSearchFilter] = useState<"all" | "user" | "file">("all");
  const [fileTypeFilter, setFileTypeFilter] = useState<"all" | "image" | "video" | "audio" | "document">("all");
  const [searchResults, setSearchResults] = useState<MatrixMessage[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Pending file attachments — staged until the user presses Send/Enter
  type PendingFile = { file: File; previewUrl: string | null };
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);

  // Get the actual scrollable viewport element from ScrollArea
  const getViewport = useCallback(() => {
    return scrollWrapperRef.current?.querySelector<HTMLElement>(
      "[data-slot='scroll-area-viewport']"
    ) ?? null;
  }, []);

  // Track whether user is near bottom + trigger older message loading on scroll up
  useEffect(() => {
    const viewport = getViewport();
    if (!viewport) return;
    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = viewport;
      const nearBottom = scrollHeight - scrollTop - clientHeight < 100;
      isNearBottomRef.current = nearBottom;
      setShowScrollToBottom(!nearBottom);
      if (scrollTop < 100) {
        loadOlderMessages();
      }
    };
    viewport.addEventListener("scroll", handleScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", handleScroll);
  }, [getViewport, loadOlderMessages, state.currentRoomId]);

  // Auto-scroll to bottom on new messages only when already near bottom
  useEffect(() => {
    if (isNearBottomRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [state.messages]);

  // Preserve scroll position after prepending older messages
  useLayoutEffect(() => {
    const viewport = getViewport();
    if (!viewport) return;
    if (prevScrollHeightRef.current > 0 && state.loadingOlderMessages === false) {
      const newScrollHeight = viewport.scrollHeight;
      const delta = newScrollHeight - prevScrollHeightRef.current;
      if (delta > 0) {
        viewport.scrollTop += delta;
      }
    }
    prevScrollHeightRef.current = viewport.scrollHeight;
  }, [state.messages, state.loadingOlderMessages, getViewport]);

  // Scroll to bottom on initial room load
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView();
  }, [state.currentRoomId]);

  // Plain async function — never memoized so it always reads the latest state/pending
  // files from the current render closure, avoiding stale-closure bugs.
  const handleSend = async () => {
    const body = getDivContent().trim();
    const hasFiles = pendingFiles.length > 0;
    if (!body && !hasFiles) return;
    if (!state.currentRoomId) return;
    if (displayLength > MAX_MESSAGE_LENGTH) return;
    const replyEventId = state.replyingTo?.event_id;
    if (inputRef.current) inputRef.current.innerHTML = "";
    setInput("");
    setDisplayLength(0);
    dispatch({ type: "SET_REPLYING_TO", payload: null });

    // Grab and clear staged files before any async work
    const toUpload = [...pendingFiles];
    setPendingFiles([]);

    // Upload each staged file and send as a message
    for (const { file, previewUrl } of toUpload) {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      const url = await uploadFile(file);
      if (url) await sendMessage(url);
    }

    // Send the text message (with reply context if set)
    if (body) {
      // Auto-resolve :shortcode: patterns to emoji
      const resolved = body.replace(/:([a-zA-Z0-9_]+):/g, (match: string, name: string) => {
        const value = mergedShortcodes[name];
        if (!value) return match;
        // If value is a URL (custom emoji), convert to :emoji{url}: format
        if (value.startsWith("/") || value.startsWith("http")) return `:emoji{${value}}:`;
        return value;
      });
      await sendMessage(resolved, replyEventId);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (emojiAutocompleteOpen) {
      const matches = Object.entries(mergedShortcodes)
        .filter(([name]) => name.toLowerCase().startsWith(emojiSearch.toLowerCase()))
        .slice(0, 8);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedEmojiIdx((i) => Math.min(i + 1, matches.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedEmojiIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && matches.length > 0) {
        e.preventDefault();
        completeEmojiShortcode(matches[selectedEmojiIdx][0], matches[selectedEmojiIdx][1]);
        return;
      }
      if (e.key === "Escape") {
        setEmojiAutocompleteOpen(false);
        return;
      }
    }
    if (mentionOpen) {
      const matches = state.roomMembers.filter((m) =>
        m.displayName.toLowerCase().startsWith(mentionSearch.toLowerCase())
      );
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedMentionIdx((i) => Math.min(i + 1, matches.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedMentionIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && matches.length > 0) {
        e.preventDefault();
        completeMention(matches[selectedMentionIdx]?.displayName);
        return;
      }
      if (e.key === "Escape") {
        setMentionOpen(false);
        return;
      }
    }
    // Backspace: manually delete an img element if the browser can't
    if (e.key === "Backspace" && inputRef.current) {
      const sel = window.getSelection();
      if (sel && sel.isCollapsed && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        const container = range.startContainer;
        const offset = range.startOffset;
        let imgToRemove: Node | null = null;
        if (container === inputRef.current && offset > 0) {
          const child = container.childNodes[offset - 1];
          if (child && (child as Element).tagName === "IMG") imgToRemove = child;
        } else if (container.nodeType === Node.TEXT_NODE && offset === 0) {
          const prev = container.previousSibling;
          if (prev && (prev as Element).tagName === "IMG") imgToRemove = prev;
        }
        if (imgToRemove) {
          e.preventDefault();
          imgToRemove.parentNode?.removeChild(imgToRemove);
          syncFromDiv();
          return;
        }
      }
    }
    if (e.key === "Escape" && state.replyingTo) {
      dispatch({ type: "SET_REPLYING_TO", payload: null });
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInput = (_e: React.FormEvent<HTMLDivElement>) => {
    const content = getDivContent();

    // Detect slash at start to enter CLI mode
    if (content === "/" && !cliMode) {
      if (inputRef.current) inputRef.current.innerHTML = "";
      setCliMode(true);
      setInput("");
      setDisplayLength(0);
      return;
    }

    setInput(content);
    setDisplayLength(computeDisplayLength());
    sendTyping();

    // Mention detection using Selection API
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !inputRef.current) {
      setMentionOpen(false);
      return;
    }
    try {
      const range = sel.getRangeAt(0);
      const preRange = document.createRange();
      preRange.setStart(inputRef.current, 0);
      preRange.setEnd(range.startContainer, range.startOffset);
      const before = preRange.toString();
      const lastAt = before.lastIndexOf("@");
      if (
        lastAt !== -1 &&
        (lastAt === before.length - 1 || /^@\w*$/.test(before.substring(lastAt)))
      ) {
        const search = before.substring(lastAt + 1);
        setMentionSearch(search);
        setMentionStart(lastAt);
        setMentionOpen(true);
        setSelectedMentionIdx(0);
      } else {
        setMentionOpen(false);
      }
    } catch {
      setMentionOpen(false);
    }

    // Emoji shortcode detection (only when mention popup is closed)
    if (!mentionOpen) {
      try {
        const range = sel.getRangeAt(0);
        const preRange = document.createRange();
        preRange.setStart(inputRef.current, 0);
        preRange.setEnd(range.startContainer, range.startOffset);
        const before = preRange.toString();
        // Find last unmatched : (not part of ://)
        const lastColon = before.lastIndexOf(":");
        if (
          lastColon !== -1 &&
          // Guard: don't trigger on :// (URLs)
          !(lastColon > 0 && before[lastColon - 1] === "/") &&
          // Only match alphanumeric/underscore after the colon
          /^:[a-zA-Z0-9_]*$/.test(before.substring(lastColon))
        ) {
          const search = before.substring(lastColon + 1);
          if (search.length > 0) {
            setEmojiSearch(search);
            setEmojiStart(lastColon);
            setEmojiAutocompleteOpen(true);
            setSelectedEmojiIdx(0);
          } else {
            setEmojiAutocompleteOpen(false);
          }
        } else {
          setEmojiAutocompleteOpen(false);
        }
      } catch {
        setEmojiAutocompleteOpen(false);
      }
    } else {
      setEmojiAutocompleteOpen(false);
    }
  };

  const completeMention = (username: string) => {
    if (!username || !inputRef.current) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    try {
      const range = sel.getRangeAt(0);
      const div = inputRef.current;
      // Get text before cursor
      const preRange = document.createRange();
      preRange.setStart(div, 0);
      preRange.setEnd(range.startContainer, range.startOffset);
      const before = preRange.toString();
      const lastAt = before.lastIndexOf("@");
      if (lastAt === -1) return;
      // Build a range spanning from @ to current cursor
      const atRange = findRangeAtOffset(div, lastAt);
      if (!atRange) return;
      atRange.setEnd(range.startContainer, range.startOffset);
      atRange.deleteContents();
      const textNode = document.createTextNode(`@${username} `);
      atRange.insertNode(textNode);
      // Move cursor after the inserted text
      const newRange = document.createRange();
      newRange.setStartAfter(textNode);
      newRange.collapse(true);
      sel.removeAllRanges();
      sel.addRange(newRange);
    } catch {
      // ignore
    }
    setMentionOpen(false);
    syncFromDiv();
    inputRef.current?.focus();
  };

  const completeEmojiShortcode = (name: string, value: string) => {
    if (!inputRef.current) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    try {
      const range = sel.getRangeAt(0);
      const div = inputRef.current;
      const preRange = document.createRange();
      preRange.setStart(div, 0);
      preRange.setEnd(range.startContainer, range.startOffset);
      const before = preRange.toString();
      const lastColon = before.lastIndexOf(":");
      if (lastColon === -1) return;
      // Build a range from the : to the current cursor
      const colonRange = findRangeAtOffset(div, lastColon);
      if (!colonRange) return;
      colonRange.setEnd(range.startContainer, range.startOffset);
      colonRange.deleteContents();
      // Insert the emoji
      const isImageUrl = value.startsWith("/") || value.startsWith("http");
      if (isImageUrl) {
        const img = document.createElement("img");
        img.src = value;
        img.dataset.emojiUrl = value;
        img.alt = `:emoji{${value}}:`;
        img.className = "inline-block h-5 w-5 object-contain align-middle mx-0.5";
        colonRange.insertNode(img);
        const newRange = document.createRange();
        newRange.setStartAfter(img);
        newRange.collapse(true);
        sel.removeAllRanges();
        sel.addRange(newRange);
      } else {
        const textNode = document.createTextNode(value);
        colonRange.insertNode(textNode);
        const newRange = document.createRange();
        newRange.setStartAfter(textNode);
        newRange.collapse(true);
        sel.removeAllRanges();
        sel.addRange(newRange);
      }
    } catch {
      // ignore
    }
    setEmojiAutocompleteOpen(false);
    syncFromDiv();
    inputRef.current?.focus();
  };

  const insertEmoji = (emoji: string) => {
    const div = inputRef.current;
    if (!div) return;
    div.focus();
    const isImageUrl = emoji.startsWith("/") || emoji.startsWith("http");
    if (isImageUrl) {
      const img = document.createElement("img");
      img.src = emoji;
      img.dataset.emojiUrl = emoji;
      img.alt = `:emoji{${emoji}}:`;
      img.className = "inline-block h-5 w-5 object-contain align-middle mx-0.5";
      insertAtCursor(img);
    } else {
      insertAtCursor(document.createTextNode(emoji));
    }
    setEmojiOpen(false);
    syncFromDiv();
    div.focus();
  };

  // Uploads a file and returns its URL; does NOT send a message.
  const uploadFile = async (file: File): Promise<string | null> => {
    if (!state.currentRoomId) return null;
    if (file.size > 500 * 1024 * 1024) {
      alert("File too large (max 500MB)");
      return null;
    }
    setUploading(true);
    setUploadProgress(0);
    setUploadFileName(file.name);
    try {
      const { url } = await apiUploadFile(file, (pct) => setUploadProgress(pct));
      return url;
    } catch (err: any) {
      alert(err.message || "Upload failed");
      return null;
    } finally {
      setUploading(false);
    }
  };

  const addPendingFile = (file: File) => {
    if (file.size > 500 * 1024 * 1024) {
      alert("File too large (max 500MB)");
      return;
    }
    setPendingFiles((prev) => {
      if (prev.length >= 4) return prev; // Max 4 attachments per message
      const previewUrl = file.type.startsWith("image/") ? URL.createObjectURL(file) : null;
      return [...prev, { file, previewUrl }];
    });
  };

  const removePendingFile = (index: number) => {
    setPendingFiles((prev) => {
      const next = [...prev];
      const removed = next.splice(index, 1)[0];
      if (removed.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      return next;
    });
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    // Convert to Array *before* resetting the value — some browsers clear the
    // FileList when e.target.value is reset, so we must snapshot it first.
    const filesList = Array.from(e.target.files ?? []);
    e.target.value = "";
    filesList.forEach(addPendingFile);
  };

  // Drag-and-drop file upload
  const [dragging, setDragging] = useState(false);
  const dragCounter = useRef(0);

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (e.dataTransfer.types.includes("Files")) {
      setDragging(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) {
      setDragging(false);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    const files = e.clipboardData?.files;
    if (files && files.length > 0) {
      e.preventDefault();
      Array.from(files).forEach(addPendingFile);
      return;
    }
    // Prevent HTML paste — insert as plain text only, but reconstitute custom emoji markers
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;

    // Split on :emoji{url}: markers and insert text nodes + img elements
    const emojiMarkerRegex = /:emoji\{([^}]+)\}:/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = emojiMarkerRegex.exec(text)) !== null) {
      // Insert any plain text before this marker
      if (match.index > lastIndex) {
        insertAtCursor(document.createTextNode(text.slice(lastIndex, match.index)));
      }
      // Insert the emoji as an inline image
      const url = match[1];
      const img = document.createElement("img");
      img.src = url;
      img.dataset.emojiUrl = url;
      img.alt = `:emoji{${url}}:`;
      img.className = "inline-block h-5 w-5 object-contain align-middle mx-0.5";
      insertAtCursor(img);
      lastIndex = match.index + match[0].length;
    }
    // Insert any remaining plain text after the last marker
    if (lastIndex < text.length) {
      insertAtCursor(document.createTextNode(text.slice(lastIndex)));
    }
    syncFromDiv();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    dragCounter.current = 0;
    const files = e.dataTransfer.files;
    if (files) {
      Array.from(files).forEach(addPendingFile);
    }
  };


  // Ctrl+O to toggle CLI mode
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "o" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        setCliMode((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Clear staged files (and revoke object URLs) when switching rooms
  useEffect(() => {
    setPendingFiles((prev) => {
      prev.forEach((pf) => pf.previewUrl && URL.revokeObjectURL(pf.previewUrl));
      return [];
    });
    // Also close search on room switch
    setSearchOpen(false);
    setSearchQuery("");
    setSearchResults([]);
    // Clear the input div on room switch
    if (inputRef.current) inputRef.current.innerHTML = "";
    setInput("");
    setDisplayLength(0);
  }, [state.currentRoomId]);

  // Debounced search execution
  useEffect(() => {
    if (!searchOpen || !state.currentRoomId) return;
    if (searchFilter !== "file" && !searchQuery.trim()) {
      setSearchResults([]);
      return;
    }
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(async () => {
      setSearchLoading(true);
      try {
        const results = await apiSearchMessages(
          state.currentRoomId!,
          searchQuery.trim(),
          searchFilter,
          fileTypeFilter
        );
        setSearchResults(results);
      } catch {
        setSearchResults([]);
      } finally {
        setSearchLoading(false);
      }
    }, 300);
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [searchQuery, searchFilter, fileTypeFilter, searchOpen, state.currentRoomId]);

  const closeSearch = () => {
    setSearchOpen(false);
    setSearchQuery("");
    setSearchResults([]);
    setSearchFilter("all");
    setFileTypeFilter("all");
  };

  const mentionMatches = mentionOpen
    ? state.roomMembers
        .filter((m) =>
          m.displayName.toLowerCase().startsWith(mentionSearch.toLowerCase())
        )
        .slice(0, 5)
    : [];

  const emojiMatches = emojiAutocompleteOpen
    ? Object.entries(mergedShortcodes)
        .filter(([name]) => name.toLowerCase().startsWith(emojiSearch.toLowerCase()))
        .slice(0, 8)
    : [];

  if (!state.currentRoomId) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-center text-muted-foreground">
          <p className="text-4xl mb-4 opacity-30">💬</p>
          <p className="text-sm">Select a room to start chatting</p>
        </div>
      </div>
    );
  }

  const roomInfo = state.roomInfoMap[state.currentRoomId];

  return (
    <div
      className="flex flex-1 flex-col min-h-0 min-w-0 relative"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {dragging && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 border-2 border-dashed border-primary rounded-lg pointer-events-none">
          <p className="text-sm font-medium text-primary">Drop file to attach</p>
        </div>
      )}
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-3">
        {/* Join voice button — only visible when not already in voice */}
        {onJoinVoice && !state.inVoiceChannel ? (
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 text-xs"
            onClick={onJoinVoice}
          >
            Join Voice
          </Button>
        ) : (
          <div className="w-8" />
        )}
        <div className="flex-1 min-w-0 text-center">
          <h2 className="text-sm font-semibold">
            {roomInfo?.name || "Unnamed Room"}
          </h2>
          {editingTopic ? (
            <input
              ref={topicInputRef}
              className="w-full max-w-xs mx-auto block text-xs text-center bg-transparent border-b border-primary outline-none text-muted-foreground"
              value={topicDraft}
              onChange={(e) => setTopicDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.currentTarget.blur();
                } else if (e.key === "Escape") {
                  setEditingTopic(false);
                }
              }}
              onBlur={() => {
                const trimmed = topicDraft.trim();
                if (trimmed !== (roomInfo?.topic || "") && state.currentRoomId) {
                  updateTopic(state.currentRoomId, trimmed);
                }
                setEditingTopic(false);
              }}
              autoFocus
            />
          ) : (
            <div
              className="overflow-hidden max-w-xs mx-auto cursor-pointer"
              onClick={() => {
                setTopicDraft(roomInfo?.topic || "");
                setEditingTopic(true);
              }}
              title="Click to edit topic"
            >
              {roomInfo?.topic ? (
                <p className="text-xs text-muted-foreground whitespace-nowrap animate-marquee">
                  {roomInfo.topic}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground/50 italic">
                  Click to set a topic
                </p>
              )}
            </div>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0"
          onClick={() => searchOpen ? closeSearch() : setSearchOpen(true)}
          title="Search messages"
        >
          <Search className="h-4 w-4" />
        </Button>
      </div>

      {/* Search bar */}
      {searchOpen && (
        <div className="border-b px-4 py-2 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <input
                type="text"
                placeholder={
                  searchFilter === "user"
                    ? "Search by username..."
                    : searchFilter === "file"
                    ? "Search by filename..."
                    : "Search messages..."
                }
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full rounded-md border border-input bg-transparent pl-8 pr-3 py-1.5 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                autoFocus
              />
            </div>
            <button
              onClick={closeSearch}
              className="text-muted-foreground hover:text-foreground cursor-pointer"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="flex gap-1">
            {(["all", "user", "file"] as const).map((f) => (
              <Button
                key={f}
                variant={searchFilter === f ? "default" : "outline"}
                size="sm"
                className="h-6 text-xs px-2"
                onClick={() => {
                  setSearchFilter(f);
                  if (f !== "file") setFileTypeFilter("all");
                }}
              >
                {f === "all" ? "All" : f === "user" ? "Users" : "Files"}
              </Button>
            ))}
          </div>
          {searchFilter === "file" && (
            <div className="flex gap-1">
              {([
                { key: "all", label: "All types", icon: null },
                { key: "image", label: "Images", icon: Image },
                { key: "video", label: "Videos", icon: Film },
                { key: "audio", label: "Audio", icon: Music },
                { key: "document", label: "Docs", icon: FileText },
              ] as const).map(({ key, label, icon: Icon }) => (
                <Button
                  key={key}
                  variant={fileTypeFilter === key ? "default" : "outline"}
                  size="sm"
                  className="h-6 text-xs px-2 gap-1"
                  onClick={() => setFileTypeFilter(key)}
                >
                  {Icon && <Icon className="h-3 w-3" />}
                  {label}
                </Button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Messages */}
      <div ref={scrollWrapperRef} className="flex-1 overflow-hidden relative">
        <ScrollArea className="h-full px-2 py-2">
          <div>
            {searchOpen ? (
              <>
                {searchLoading && (
                  <div className="text-center text-xs text-muted-foreground py-4">
                    Searching...
                  </div>
                )}
                {!searchLoading && searchResults.length === 0 && (searchQuery.trim() || searchFilter === "file") && (
                  <div className="text-center text-xs text-muted-foreground py-4">
                    {searchFilter === "file" ? "No files found" : "No results found"}
                  </div>
                )}
                {!searchLoading && searchResults.length === 0 && !searchQuery.trim() && searchFilter !== "file" && (
                  <div className="text-center text-xs text-muted-foreground py-4">
                    Type to search messages
                  </div>
                )}
                {searchResults.map((msg, i) => {
                  const prev = searchResults[i - 1];
                  const grouped =
                    !!prev &&
                    prev.content.msgtype !== "m.system" &&
                    msg.content.msgtype !== "m.system" &&
                    prev.sender === msg.sender &&
                    msg.origin_server_ts - prev.origin_server_ts < 60000;
                  return (
                    <MessageItem key={msg.event_id} message={msg} grouped={grouped} />
                  );
                })}
              </>
            ) : (
              <>
                {state.loadingOlderMessages && (
                  <div className="text-center text-xs text-muted-foreground py-2">
                    Loading older messages...
                  </div>
                )}
                {!state.hasMoreMessages && state.messages.length > 0 && (
                  <div className="text-center text-xs text-muted-foreground py-2">
                    Beginning of conversation
                  </div>
                )}
                {state.messages.map((msg, i) => {
                  const prev = state.messages[i - 1];
                  const grouped =
                    !!prev &&
                    prev.content.msgtype !== "m.system" &&
                    msg.content.msgtype !== "m.system" &&
                    prev.sender === msg.sender &&
                    msg.origin_server_ts - prev.origin_server_ts < 60000;
                  return (
                    <MessageItem key={msg.event_id} message={msg} grouped={grouped} />
                  );
                })}
                <div ref={messagesEndRef} />
              </>
            )}
          </div>
        </ScrollArea>
        {showScrollToBottom && (
          <Button
            variant="secondary"
            size="icon"
            className="absolute bottom-3 right-5 h-8 w-8 rounded-full shadow-lg border opacity-80 hover:opacity-100 transition-opacity z-10"
            onClick={() => {
              messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
            }}
          >
            <ArrowDown className="h-4 w-4" />
          </Button>
        )}
      </div>

      {/* Reply preview */}
      {state.replyingTo && (
        <div className="border-t border-l-2 border-l-primary mx-3 mt-2 px-3 py-2 bg-accent/30 rounded-sm flex items-center justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-primary">
              Replying to {state.userPresence[state.replyingTo.sender]?.displayName || displayUserId(state.replyingTo.sender)}
            </p>
            <p className="text-xs text-muted-foreground truncate inline-flex items-center gap-0.5">
              {renderInlineEmojis(state.replyingTo.content.body)}
            </p>
          </div>
          <button
            className="text-muted-foreground hover:text-foreground text-sm flex-shrink-0 cursor-pointer"
            onClick={() => dispatch({ type: "SET_REPLYING_TO", payload: null })}
          >
            ✕
          </button>
        </div>
      )}

      {/* Typing indicator */}
      {state.typingUsers.length > 0 && (() => {
        const names = state.typingUsers.map((uid) => {
          const member = state.roomMembers.find((m) => m.userId === uid);
          return member?.displayName || displayUserId(uid);
        });
        let text: string;
        if (names.length === 1) {
          text = `${names[0]} is typing...`;
        } else if (names.length === 2) {
          text = `${names[0]} and ${names[1]} are typing...`;
        } else if (names.length === 3) {
          text = `${names[0]}, ${names[1]}, and ${names[2]} are typing...`;
        } else {
          text = "Multiple users are yapping....";
        }
        return (
          <div className="px-4 pb-1 flex items-center gap-1.5">
            <span className="flex gap-0.5">
              <span className="w-1 h-1 rounded-full bg-muted-foreground animate-bounce [animation-delay:0ms]" />
              <span className="w-1 h-1 rounded-full bg-muted-foreground animate-bounce [animation-delay:150ms]" />
              <span className="w-1 h-1 rounded-full bg-muted-foreground animate-bounce [animation-delay:300ms]" />
            </span>
            <span className="text-xs text-muted-foreground italic">{text}</span>
          </div>
        );
      })()}

      {/* Input */}
      {cliMode ? (
        <CommandBar onClose={() => setCliMode(false)} />
      ) : (
        <div className="border-t p-3">
          {/* Staged file previews */}
          {pendingFiles.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2">
              {pendingFiles.map((pf, i) => (
                <div key={i} className="relative group">
                  {pf.previewUrl ? (
                    <img
                      src={pf.previewUrl}
                      alt={pf.file.name}
                      className="h-16 w-16 object-cover rounded-md border border-border"
                    />
                  ) : (
                    <div className="h-16 w-28 flex flex-col items-center justify-center rounded-md border border-border bg-muted px-2 gap-1">
                      <span className="text-lg">📄</span>
                      <span className="text-xs text-muted-foreground truncate max-w-full">{pf.file.name}</span>
                    </div>
                  )}
                  <button
                    className="absolute -top-1.5 -right-1.5 h-4 w-4 rounded-full bg-destructive text-destructive-foreground text-[10px] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer leading-none"
                    onClick={() => removePendingFile(i)}
                    title="Remove"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
          {displayLength > MAX_MESSAGE_LENGTH * 0.75 && (
            <div className="flex justify-end mb-1">
              <span
                className={`text-xs font-mono px-1.5 py-0.5 rounded ${
                  displayLength > MAX_MESSAGE_LENGTH
                    ? "bg-destructive/20 text-destructive font-semibold"
                    : displayLength > MAX_MESSAGE_LENGTH * 0.9
                    ? "text-orange-400"
                    : "text-muted-foreground"
                }`}
              >
                {displayLength}/{MAX_MESSAGE_LENGTH}
              </span>
            </div>
          )}
          <div className="relative flex gap-2">
            {/* Mention autocomplete */}
            {mentionOpen && mentionMatches.length > 0 && (
              <div className="absolute bottom-full left-0 mb-1 w-56 rounded-md border bg-popover p-1 shadow-lg z-50">
                {mentionMatches.map((m, i) => (
                  <button
                    key={m.userId}
                    className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm cursor-pointer transition-colors ${
                      i === selectedMentionIdx ? "bg-accent" : "hover:bg-accent/50"
                    }`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      completeMention(m.displayName);
                    }}
                  >
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-secondary text-xs font-semibold">
                      {m.displayName[0]?.toUpperCase()}
                    </span>
                    <span>{m.displayName}</span>
                  </button>
                ))}
              </div>
            )}

            {/* Emoji shortcode autocomplete */}
            {emojiAutocompleteOpen && emojiMatches.length > 0 && (
              <div className="absolute bottom-full left-0 mb-1 w-64 rounded-md border bg-popover p-1 shadow-lg z-50 max-h-72 overflow-y-auto">
                {emojiMatches.map(([name, value], i) => {
                  const isUrl = value.startsWith("/") || value.startsWith("http");
                  return (
                    <button
                      key={name}
                      className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm cursor-pointer transition-colors ${
                        i === selectedEmojiIdx ? "bg-accent" : "hover:bg-accent/50"
                      }`}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        completeEmojiShortcode(name, value);
                      }}
                    >
                      <span className="flex h-6 w-6 items-center justify-center text-base">
                        {isUrl ? (
                          <img src={value} alt={name} className="h-5 w-5 object-contain" />
                        ) : (
                          value
                        )}
                      </span>
                      <span className="text-muted-foreground">:{name}:</span>
                    </button>
                  );
                })}
              </div>
            )}

            {/* Hidden file input triggered by the label below */}
            <input
              id="chat-file-input"
              type="file"
              ref={fileInputRef}
              className="hidden"
              multiple
              onChange={handleFileSelect}
            />
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0"
              disabled={uploading}
              asChild
            >
              {/* Using a label instead of onClick+click() is universally reliable */}
              <label
                htmlFor={uploading ? undefined : "chat-file-input"}
                className={uploading ? "cursor-not-allowed" : "cursor-pointer"}
                title="Attach files (max 4)"
              >
                {uploading ? "…" : "+"}
              </label>
            </Button>

            <div className="relative flex-1">
              {/* Placeholder — shown when the div is empty */}
              {!input && (
                <span className="absolute top-2 left-3 text-sm text-muted-foreground pointer-events-none select-none z-10">
                  Type your message... (/ for commands, Ctrl+O for CLI)
                </span>
              )}
              <div
                ref={inputRef}
                contentEditable
                role="textbox"
                aria-multiline="true"
                aria-label="Message input"
                onInput={handleInput}
                onKeyDown={handleKeyPress}
                onPaste={handlePaste}
                suppressContentEditableWarning
                className={`w-full rounded-md border border-input bg-transparent px-3 py-2 pr-10 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring min-h-[36px] max-h-40 overflow-y-auto break-words ${displayLength > MAX_MESSAGE_LENGTH ? "ring-2 ring-destructive focus-visible:ring-destructive" : ""}`}
                style={{ wordBreak: "break-word", whiteSpace: "pre-wrap", lineHeight: "20px" }}
              />

              {/* GIF picker */}
              <Popover open={gifOpen} onOpenChange={setGifOpen}>
                <PopoverTrigger asChild>
                  <button className="absolute right-9 top-1/2 -translate-y-1/2 text-xs font-bold text-muted-foreground hover:text-foreground hover:scale-110 transition-all cursor-pointer">
                    GIF
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  side="top"
                  align="end"
                  className="w-auto p-0"
                >
                  <GifPicker
                    onSelect={(gifUrl) => {
                      setGifOpen(false);
                      const el = inputRef.current;
                      if (el) {
                        const current = el.textContent || "";
                        const newVal = current ? current + " " + gifUrl : gifUrl;
                        el.textContent = newVal;
                        setInput(newVal);
                        // Place cursor at end
                        const range = document.createRange();
                        const sel = window.getSelection();
                        range.selectNodeContents(el);
                        range.collapse(false);
                        sel?.removeAllRanges();
                        sel?.addRange(range);
                        el.focus();
                      } else {
                        setInput((prev) => (prev ? prev + " " + gifUrl : gifUrl));
                      }
                    }}
                  />
                </PopoverContent>
              </Popover>

              {/* Emoji picker */}
              <Popover open={emojiOpen} onOpenChange={setEmojiOpen}>
                <PopoverTrigger asChild>
                  <button className="absolute right-2 top-1/2 -translate-y-1/2 text-lg hover:scale-110 transition-transform cursor-pointer">
                    😊
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  side="top"
                  align="end"
                  className="w-auto p-0"
                >
                  <EmojiPicker
                    onSelect={insertEmoji}
                    roomCustomEmojis={
                      state.currentRoomId
                        ? (state.roomInfoMap[state.currentRoomId]?.custom_emojis ?? [])
                        : []
                    }
                    emojiAliases={
                      state.currentRoomId
                        ? (state.roomInfoMap[state.currentRoomId]?.emoji_aliases ?? {})
                        : {}
                    }
                  />
                </PopoverContent>
              </Popover>
            </div>

            <Button
              onClick={handleSend}
              size="default"
              disabled={displayLength > MAX_MESSAGE_LENGTH}
            >
              Send
            </Button>
          </div>
        </div>
      )}
      <Dialog open={uploading}>
        <DialogContent
          className="sm:max-w-[300px]"
          onPointerDownOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
          showCloseButton={false}
        >
          <DialogHeader>
            <DialogTitle className="text-sm">Uploading file</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground truncate">{uploadFileName}</p>
            <div className="bg-muted rounded-full h-2">
              <div
                className="bg-primary rounded-full h-2 transition-all"
                style={{ width: `${uploadProgress}%` }}
              />
            </div>
            <p className="text-xs text-muted-foreground text-center">{uploadProgress}%</p>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
