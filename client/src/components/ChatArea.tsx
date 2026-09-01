import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from "react";
import { useAppContext } from "@/lib/store";
import { useIsMobile } from "@/hooks/use-mobile";
import { apiUploadFile, apiSearchMessages, apiGetRoomThreads, apiUpdateChannel, type MatrixMessage } from "@/lib/api";
import { STANDARD_SHORTCODES } from "@/lib/emojiShortcodes";
import { MessageItem } from "./MessageItem";
import { Search, X, ArrowDown, Image, Film, Music, FileText, EyeOff, MessageSquare, AtSign, UserPlus, Pencil } from "lucide-react";
import { CommandBar } from "./CommandBar";
import { AddToDMDialog } from "./AddToDMDialog";
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
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmojiPicker, renderInlineEmojis } from "./EmojiPicker";
import { GifPicker } from "./GifPicker";
import { displayUserId } from "@/lib/utils";

const MAX_MESSAGE_LENGTH = 4000;

async function stripExifData(file: File): Promise<File> {
  return new Promise((resolve) => {
    const img = document.createElement("img");
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        URL.revokeObjectURL(objectUrl);
        return resolve(file);
      }
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(objectUrl);
      canvas.toBlob(
        (blob) => {
          if (!blob) return resolve(file);
          resolve(new File([blob], file.name, { type: blob.type }));
        },
        file.type,
        1.0
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(file);
    };
    img.src = objectUrl;
  });
}

const mediaUrlRegex = /(https?:\/\/[^\s]+)/g;
const mediaImageExtensions = /\.(jpg|jpeg|png|gif|webp|bmp|svg)(\?.*)?$/i;
const mediaVideoExtensions = /\.(mp4|webm|ogg|mov|mkv)(\?.*)?$/i;

interface ChatAreaProps {
  onJoinVoice?: () => void;
}

export function ChatArea({ onJoinVoice }: ChatAreaProps) {
  const { state, dispatch, sendMessage, sendTyping, updateTopic, updateRoomSettings, loadOlderMessages, loadMessagesAround, openThread, selectChannel } = useAppContext();
  const isMobile = useIsMobile();
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
  const [addToDMOpen, setAddToDMOpen] = useState(false);
  const [editingDMName, setEditingDMName] = useState(false);
  const [dmNameDraft, setDmNameDraft] = useState("");
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
  const [uploadProcessing, setUploadProcessing] = useState(false);
  const [cliMode, setCliMode] = useState(false);
  const [exifDialogOpen, setExifDialogOpen] = useState(false);
  const exifPendingFilesRef = useRef<File[]>([]);
  const [displayLength, setDisplayLength] = useState(0);
  const [editingEventId, setEditingEventId] = useState<string | null>(null);

  // Unread "New" divider state
  const [showNewDivider, setShowNewDivider] = useState(false);
  const showNewDividerRef = useRef(false);
  const [firstUnreadEventId, setFirstUnreadEventId] = useState<string | null>(null);
  const newDividerRef = useRef<HTMLDivElement>(null);
  const unreadCountRef = useRef(0);
  const pendingDividerRef = useRef(false);
  const prevChannelIdRef = useRef<string | null>(state.currentChannelId);
  const currentChannelIdRef = useRef<string | null>(state.currentChannelId);

  // Room-level unread banner state
  const [roomUnreadBannerCount, setRoomUnreadBannerCount] = useState(0);
  const roomUnreadBannerRef = useRef(0);
  const prevRoomIdRef = useRef<string | null>(null);

  // Merge standard shortcodes + room emoji aliases (room overrides standard)
  const mergedShortcodes = useMemo(() => {
    const roomAliases = state.currentRoomId
      ? (state.roomInfoMap[state.currentRoomId]?.emoji_aliases ?? {})
      : {};
    return { ...STANDARD_SHORTCODES, ...roomAliases };
  }, [state.currentRoomId, state.roomInfoMap]);

  // Detect image/video URLs in the input for thumbnail previews
  const mediaUrls = useMemo(() => {
    const results: { url: string; type: "image" | "video" }[] = [];
    const stripped = input.replace(/:emoji\{[^}]+\}:/g, "");
    const matches = stripped.match(mediaUrlRegex);
    if (matches) {
      for (const url of matches) {
        if (mediaImageExtensions.test(url)) results.push({ url, type: "image" });
        else if (mediaVideoExtensions.test(url)) results.push({ url, type: "video" });
      }
    }
    return results;
  }, [input]);

  // Remove a media URL from the input
  const removeMediaUrl = useCallback((urlToRemove: string) => {
    const el = inputRef.current;
    if (!el) return;
    const current = getDivContent();
    const newVal = current.replace(urlToRemove, "").replace(/  +/g, " ").trim();
    el.textContent = newVal;
    setInput(newVal);
  }, []);

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

  // Mentions state
  const [mentionsOpen, setMentionsOpen] = useState(false);
  const [mentionResults, setMentionResults] = useState<MatrixMessage[]>([]);
  const [mentionsLoading, setMentionsLoading] = useState(false);

  // Search state lives in the shared store (see client/src/lib/store) so the
  // members panel (input + filters) and this chat area (results) stay in sync.
  const search = state.search;
  const [scrollToEventId, setScrollToEventId] = useState<string | null>(null);

  const closeSearch = () => dispatch({ type: "CLOSE_SEARCH" });

  // Pending file attachments — staged until the user presses Send/Enter
  type PendingFile = { file: File; previewUrl: string | null };
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [isSpoiler, setIsSpoiler] = useState(false);

  // Get the actual scrollable viewport element from ScrollArea
  const getViewport = useCallback(() => {
    return scrollWrapperRef.current?.querySelector<HTMLElement>(
      "[data-slot='scroll-area-viewport']"
    ) ?? null;
  }, []);

  // Scroll only the viewport to the bottom — avoids scrollIntoView() which can
  // scroll overflow:hidden ancestors in Chromium, causing layout shifts.
  const scrollToBottom = useCallback((behavior: ScrollBehavior = "instant") => {
    const viewport = getViewport();
    if (viewport) viewport.scrollTo({ top: viewport.scrollHeight, behavior });
  }, [getViewport]);

  // Capture room-level unread count on room change and show banner
  useEffect(() => {
    if (state.currentRoomId !== prevRoomIdRef.current) {
      prevRoomIdRef.current = state.currentRoomId;
      if (state.currentRoomId) {
        const count = state.roomUnreadCounts[state.currentRoomId] || 0;
        roomUnreadBannerRef.current = count;
        setRoomUnreadBannerCount(count);
        if (count > 0) {
          dispatch({ type: "CLEAR_ROOM_UNREAD", payload: state.currentRoomId });
        }
      } else {
        roomUnreadBannerRef.current = 0;
        setRoomUnreadBannerCount(0);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.currentRoomId]);

  // Detect channel change and capture unread count for "New" divider
  useEffect(() => {
    const channelId = state.currentChannelId;
    if (channelId !== prevChannelIdRef.current) {
      currentChannelIdRef.current = channelId;
      const count = state.channelUnreadCounts[channelId ?? ""] || 0;
      unreadCountRef.current = count;
      if (count > 0) {
        pendingDividerRef.current = true;
        showNewDividerRef.current = true;
        setShowNewDivider(true);
        isNearBottomRef.current = false;
        // Clear the badge immediately — count is already captured in unreadCountRef for the divider
        dispatch({ type: "CLEAR_CHANNEL_UNREAD", payload: channelId! });
      } else {
        pendingDividerRef.current = false;
        showNewDividerRef.current = false;
        setShowNewDivider(false);
        setFirstUnreadEventId(null);
      }
      prevChannelIdRef.current = channelId;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.currentChannelId]);

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
      // Clear unread divider when user scrolls to bottom
      if (nearBottom && showNewDividerRef.current) {
        showNewDividerRef.current = false;
        setShowNewDivider(false);
        setFirstUnreadEventId(null);
        const channelId = currentChannelIdRef.current;
        if (channelId) {
          dispatch({ type: "CLEAR_CHANNEL_UNREAD", payload: channelId });
        }
      }
      // Clear room unread banner when user scrolls to bottom
      if (nearBottom && roomUnreadBannerRef.current > 0) {
        roomUnreadBannerRef.current = 0;
        setRoomUnreadBannerCount(0);
      }
    };
    viewport.addEventListener("scroll", handleScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", handleScroll);
  }, [getViewport, loadOlderMessages, state.currentRoomId, dispatch]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    scrollToBottom("smooth");
  }, [state.messages, scrollToBottom]);

  // Scroll to show reactions added to the last message
  useEffect(() => {
    const lastMessage = state.messages[state.messages.length - 1];
    if (!lastMessage) return;
    if (state.messageReactions[lastMessage.event_id] && isNearBottomRef.current) {
      scrollToBottom("smooth");
    }
  }, [state.messageReactions, state.messages, scrollToBottom]);

  // Scroll to bottom on channel switch
  useEffect(() => {
    if (state.currentChannelId) {
      scrollToBottom();
    }
  }, [state.currentChannelId, scrollToBottom]);

  // When messages load for a channel with unreads, compute the first unread event ID
  useLayoutEffect(() => {
    if (pendingDividerRef.current && state.messages.length > 0) {
      const count = unreadCountRef.current;
      const idx = Math.max(0, state.messages.length - count);
      setFirstUnreadEventId(state.messages[idx]?.event_id ?? null);
      pendingDividerRef.current = false;
    }
  }, [state.messages]);

  // Scroll to the "New" divider after it renders
  useLayoutEffect(() => {
    if (firstUnreadEventId && newDividerRef.current) {
      newDividerRef.current.scrollIntoView({ block: "start" });
    }
  }, [firstUnreadEventId]);

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
    scrollToBottom();
  }, [state.currentRoomId, scrollToBottom]);

  // Focus the input when the user starts a reply
  useEffect(() => {
    if (state.replyingTo) {
      inputRef.current?.focus();
    }
  }, [state.replyingTo]);

  // Plain async function — never memoized so it always reads the latest state/pending
  // files from the current render closure, avoiding stale-closure bugs.
  const handleSend = async () => {
    const body = getDivContent().trim();
    const hasFiles = pendingFiles.length > 0;
    if (!body && !hasFiles) return;
    if (!state.currentRoomId) return;
    if (displayLength > MAX_MESSAGE_LENGTH) return;
    const replyEventId = state.replyingTo?.event_id;
    const spoiler = isSpoiler;
    if (inputRef.current) inputRef.current.innerHTML = "";
    setInput("");
    setDisplayLength(0);
    setIsSpoiler(false);
    dispatch({ type: "SET_REPLYING_TO", payload: null });

    // Grab and clear staged files before any async work
    const toUpload = [...pendingFiles];
    setPendingFiles([]);

    // Auto-resolve :shortcode: patterns to emoji in body text
    const resolveShortcodes = (raw: string) =>
      raw.replace(/:([a-zA-Z0-9_]+):/g, (match: string, name: string) => {
        const value = mergedShortcodes[name];
        if (!value) return match;
        if (value.startsWith("/") || value.startsWith("http")) return `:emoji{${value}}:`;
        return value;
      });

    if (toUpload.length > 0 && body) {
      // Files + text: upload all files first, then send as one combined message
      // so text and images aren't split into separate spoiler/reply messages.
      const uploadedUrls: string[] = [];
      for (const { file, previewUrl } of toUpload) {
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        const url = await uploadFile(file);
        if (url) uploadedUrls.push(url);
      }
      const parts = [resolveShortcodes(body), ...uploadedUrls].filter(Boolean);
      if (parts.length > 0) {
        await sendMessage(parts.join("\n"), replyEventId, spoiler);
      }
    } else {
      // Files only: send each as its own message
      for (const { file, previewUrl } of toUpload) {
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        const url = await uploadFile(file);
        if (url) await sendMessage(url, undefined, spoiler);
      }
      // Text only: send as one message
      if (body) {
        await sendMessage(resolveShortcodes(body), replyEventId, spoiler);
      }
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
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedMentionIdx((i) => Math.min(i + 1, mentionMatches.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedMentionIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && mentionMatches.length > 0) {
        e.preventDefault();
        completeMention(mentionMatches[selectedMentionIdx]?.name);
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
    // ArrowUp on empty input: edit most recent own message
    if (e.key === "ArrowUp" && !emojiAutocompleteOpen && !mentionOpen) {
      const content = getDivContent().trim();
      if (content === "") {
        const lastOwnMsg = [...state.messages].reverse().find(
          (m) => m.sender === state.userId && m.content.msgtype !== "m.system" && !m.redacted
        );
        if (lastOwnMsg) {
          e.preventDefault();
          setEditingEventId(lastOwnMsg.event_id);
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
    // Check if cursor is already inside the div before focusing
    const sel = window.getSelection();
    const hadCursorInDiv = sel && sel.rangeCount > 0 && div.contains(sel.getRangeAt(0).commonAncestorContainer);
    div.focus();
    // If cursor wasn't in the div (e.g. emoji picker had focus), move cursor to end
    if (!hadCursorInDiv && sel) {
      const range = document.createRange();
      range.selectNodeContents(div);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }
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
    if (state.uploadLimitBytes > 0 && file.size > state.uploadLimitBytes) {
      alert(`File too large (max ${Math.round(state.uploadLimitBytes / 1024 / 1024)} MB)`);
      return null;
    }
    setUploading(true);
    setUploadProgress(0);
    setUploadProcessing(false);
    setUploadFileName(file.name);
    try {
      const { url } = await apiUploadFile(file, (pct) => {
        setUploadProgress(pct);
        // When upload data reaches 100%, the server processes the file
        // (ffmpeg conversion/faststart). Show processing state.
        if (pct >= 100) setUploadProcessing(true);
      });
      return url;
    } catch (err: any) {
      alert(err.message || "Upload failed");
      return null;
    } finally {
      setUploading(false);
      setUploadProcessing(false);
    }
  };

  const addPendingFile = (file: File) => {
    if (state.uploadLimitBytes > 0 && file.size > state.uploadLimitBytes) {
      alert(`File too large (max ${Math.round(state.uploadLimitBytes / 1024 / 1024)} MB)`);
      return;
    }
    setPendingFiles((prev) => {
      if (prev.length >= 4) return prev; // Max 4 attachments per message
      const previewUrl = file.type.startsWith("image/") ? URL.createObjectURL(file) : null;
      return [...prev, { file, previewUrl }];
    });
  };

  const processFiles = (files: File[]) => {
    const imageFiles = files.filter((f) => f.type.startsWith("image/"));
    const otherFiles = files.filter((f) => !f.type.startsWith("image/"));
    otherFiles.forEach(addPendingFile);
    if (imageFiles.length === 0) return;
    exifPendingFilesRef.current = imageFiles;
    setExifDialogOpen(true);
  };

  const handleExifChoice = async (scrub: boolean) => {
    setExifDialogOpen(false);
    const files = exifPendingFilesRef.current;
    exifPendingFilesRef.current = [];
    for (const file of files) {
      const processed = scrub ? await stripExifData(file) : file;
      addPendingFile(processed);
    }
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
    processFiles(filesList);
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
      processFiles(Array.from(files));
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
      processFiles(Array.from(files));
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
    // Search is reset on room switch by the provider (see client/src/lib/store/provider.tsx)
    // Clear the input div on room switch
    if (inputRef.current) inputRef.current.innerHTML = "";
    setInput("");
    setDisplayLength(0);
  }, [state.currentRoomId]);

  // Debounced search execution now lives in the provider (client/src/lib/store/provider.tsx)

  const closeMentions = () => {
    setMentionsOpen(false);
    setMentionResults([]);
  };

  const openMentions = async () => {
    if (!state.currentRoomId || !state.userId) return;
    closeSearch();
    setMentionsOpen(true);
    setMentionsLoading(true);
    const username = state.userId.replace(/^@/, "").replace(/:.*$/, "");
    try {
      const results = await apiSearchMessages(state.currentRoomId, username, "mention");
      setMentionResults(results);
    } finally {
      setMentionsLoading(false);
    }
  };

  // Format relative time for thread list
  const formatThreadTime = (ts: number) => {
    const date = new Date(ts);
    const now = Date.now();
    const diff = now - ts;
    if (diff < 60_000) return "just now";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  };

  // Scroll to a message after search/mentions closes and messages are rendered
  useEffect(() => {
    if (!scrollToEventId || search.open || mentionsOpen) return;
    // Use requestAnimationFrame to wait for DOM to render
    const raf = requestAnimationFrame(() => {
      const el = document.querySelector(`[data-event-id="${scrollToEventId}"]`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.add("bg-accent");
        setTimeout(() => el.classList.remove("bg-accent"), 1500);
      }
      setScrollToEventId(null);
    });
    return () => cancelAnimationFrame(raf);
  }, [scrollToEventId, search.open, mentionsOpen, state.messages]);

  const mentionMatches = useMemo(() => {
    if (!mentionOpen) return [];
    const roomInfo = state.currentRoomId ? state.roomInfoMap[state.currentRoomId] : null;
    const builtInRoles: { kind: "role"; id: string; name: string; color: string | undefined }[] = [];
    for (const r of [{ name: "owner", color: roomInfo?.owner_name_color }, { name: "moderator", color: roomInfo?.mod_name_color }]) {
      if (r.name.toLowerCase().startsWith(mentionSearch.toLowerCase())) {
        builtInRoles.push({ kind: "role", id: `builtin-${r.name}`, name: r.name, color: r.color || undefined });
      }
    }
    return [
      ...state.roomMembers
        .filter((m) =>
          m.displayName.toLowerCase().startsWith(mentionSearch.toLowerCase())
        )
        .slice(0, 5)
        .map((m) => ({ kind: "user" as const, id: m.userId, name: m.displayName, color: undefined as string | undefined })),
      ...builtInRoles,
      ...state.customRoles
        .filter((r) =>
          r.name.toLowerCase().startsWith(mentionSearch.toLowerCase())
        )
        .slice(0, 5)
        .map((r) => ({ kind: "role" as const, id: r.role_id, name: r.name, color: r.color || undefined })),
    ].slice(0, 8);
  }, [mentionOpen, mentionSearch, state.roomMembers, state.customRoles, state.currentRoomId, state.roomInfoMap]);

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
      className="flex flex-1 flex-col min-h-0 min-w-0 relative bg-background"
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
      {/* Header — compact on mobile since MobileHeader shows room name */}
      <div className={`flex items-center justify-between border-b px-4 ${isMobile ? "py-1.5" : "py-3"}`}>
        <div className={isMobile ? "w-0" : "w-8"} />
        <div className={`flex-1 min-w-0 text-center ${isMobile ? "hidden" : ""}`}>
          {roomInfo?.is_direct && editingDMName ? (
            <input
              className="text-sm font-semibold text-center bg-transparent border-b border-primary outline-none w-full max-w-xs mx-auto block"
              value={dmNameDraft}
              onChange={(e) => setDmNameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                else if (e.key === "Escape") setEditingDMName(false);
              }}
              onBlur={async () => {
                const trimmed = dmNameDraft.trim();
                const current = roomInfo?.name || "";
                if (trimmed && trimmed !== current && state.currentRoomId) {
                  await updateRoomSettings(state.currentRoomId, { name: trimmed });
                }
                setEditingDMName(false);
              }}
              autoFocus
            />
          ) : (
            <h2
              className={`text-sm font-semibold ${roomInfo?.is_direct ? "group inline-flex items-center gap-1 cursor-pointer" : ""}`}
              onClick={() => {
                if (roomInfo?.is_direct) {
                  setDmNameDraft(roomInfo.name || "");
                  setEditingDMName(true);
                }
              }}
              title={roomInfo?.is_direct ? "Click to rename" : undefined}
            >
              {state.currentChannelId && state.channels.length > 0
                ? `# ${state.channels.find((c) => c.channel_id === state.currentChannelId)?.name || "channel"}`
                : roomInfo?.name || "Unnamed Room"}
              {roomInfo?.is_direct && (
                <Pencil className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
              )}
            </h2>
          )}
          {(() => {
            const currentChannel = state.channels.find((c) => c.channel_id === state.currentChannelId);
            const channelTopic = currentChannel?.topic || "";
            return editingTopic ? (
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
                onBlur={async () => {
                  const trimmed = topicDraft.trim();
                  if (trimmed !== channelTopic && state.currentRoomId && state.currentChannelId) {
                    await apiUpdateChannel(state.currentRoomId, state.currentChannelId, { topic: trimmed });
                    dispatch({ type: "UPDATE_CHANNEL", payload: { channel_id: state.currentChannelId, topic: trimmed } });
                  }
                  setEditingTopic(false);
                }}
                autoFocus
              />
            ) : (
              <div
                className="overflow-hidden max-w-xs mx-auto cursor-pointer"
                onClick={() => {
                  setTopicDraft(channelTopic);
                  setEditingTopic(true);
                }}
                title="Click to edit channel topic"
              >
                {channelTopic ? (
                  <p className="text-xs text-muted-foreground whitespace-nowrap animate-marquee">
                    {channelTopic}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground/50 italic">
                    Click to set a topic
                  </p>
                )}
              </div>
            );
          })()}
        </div>
        <div className="flex items-center gap-1">
          {roomInfo?.is_direct && state.currentRoomId && (
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0"
              onClick={() => setAddToDMOpen(true)}
              title="Add people to DM"
            >
              <UserPlus className="h-4 w-4" />
            </Button>
          )}
          {roomInfo?.room_type === "text" && (
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0"
              onClick={() => mentionsOpen ? closeMentions() : openMentions()}
              title="Your mentions"
            >
              <AtSign className="h-4 w-4" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0"
            onClick={() => search.open ? closeSearch() : (closeMentions(), dispatch({ type: "SET_SEARCH", payload: { open: true } }))}
            title="Search messages"
          >
            <Search className="h-4 w-4" />
          </Button>
        </div>
      </div>
      {state.currentRoomId && (
        <AddToDMDialog
          open={addToDMOpen}
          onOpenChange={setAddToDMOpen}
          roomId={state.currentRoomId}
        />
      )}

      {/* Mentions bar */}
      {mentionsOpen && (
        <div className="border-b px-4 py-2 flex items-center justify-between">
          <span className="text-sm font-medium flex items-center gap-1.5">
            <AtSign className="h-3.5 w-3.5 text-muted-foreground" />
            Your mentions
          </span>
          <button
            onClick={closeMentions}
            className="text-muted-foreground hover:text-foreground cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Search bar */}
      {search.open && (
        <div className="border-b px-4 py-2 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <input
                type="text"
                placeholder={
                  search.filter === "user"
                    ? "Search by username..."
                    : search.filter === "file"
                    ? "Search by filename..."
                    : search.filter === "thread"
                    ? "Search threads..."
                    : "Search messages..."
                }
                value={search.query}
                onChange={(e) => dispatch({ type: "SET_SEARCH", payload: { query: e.target.value } })}
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
            {(["all", "user", "file", "thread"] as const).map((f) => (
              <Button
                key={f}
                variant={search.filter === f ? "default" : "outline"}
                size="sm"
                className="h-6 text-xs px-2"
                onClick={() => {
                  dispatch({ type: "SET_SEARCH", payload: { filter: f } });
                  if (f !== "file") dispatch({ type: "SET_SEARCH", payload: { fileTypeFilter: "all" } });
                }}
              >
                {f === "all" ? "All" : f === "user" ? "Users" : f === "file" ? "Files" : "Threads"}
              </Button>
            ))}
            <div className="flex-1" />
            <Button
              variant={search.thisChannel ? "default" : "outline"}
              size="sm"
              className="h-6 text-xs px-2"
              title={search.thisChannel ? "Only search this channel" : "Search all channels in the room"}
              onClick={() => dispatch({ type: "SET_SEARCH", payload: { thisChannel: !search.thisChannel } })}
            >
              This channel
            </Button>
          </div>
          {search.filter === "file" && (
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
                  variant={search.fileTypeFilter === key ? "default" : "outline"}
                  size="sm"
                  className="h-6 text-xs px-2 gap-1"
                  onClick={() => dispatch({ type: "SET_SEARCH", payload: { fileTypeFilter: key } })}
                >
                  {Icon && <Icon className="h-3 w-3" />}
                  {label}
                </Button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Unread messages banner */}
      {roomUnreadBannerCount > 0 && (
        <div className="flex items-center justify-between px-4 py-2 bg-purple-600 text-white text-sm font-medium shrink-0">
          <span>{roomUnreadBannerCount} unread message{roomUnreadBannerCount !== 1 ? "s" : ""} since your last visit</span>
          <button
            onClick={() => {
              roomUnreadBannerRef.current = 0;
              setRoomUnreadBannerCount(0);
            }}
            className="ml-4 rounded px-2 py-0.5 text-xs text-white/90 hover:text-white border border-white/30 hover:border-white/60 transition-colors cursor-pointer"
          >
            Read
          </button>
        </div>
      )}

      {/* Messages */}
      <div ref={scrollWrapperRef} className="flex-1 overflow-hidden relative">
        <ScrollArea className={`h-full py-2 ${isMobile ? "px-1" : "px-2"}`}>
          <div>
            {search.open ? (
              <>
                {search.loading && (
                  <div className="text-center text-xs text-muted-foreground py-4">
                    Searching...
                  </div>
                )}
                {!search.loading && search.results.length === 0 && search.filter === "thread" && (
                  <div className="text-center text-xs text-muted-foreground py-4">
                    {search.query.trim() ? "No threads found" : "No threads in this room yet"}
                  </div>
                )}
                {!search.loading && search.results.length === 0 && search.filter !== "thread" && (search.query.trim() || search.filter === "file") && (
                  <div className="text-center text-xs text-muted-foreground py-4">
                    {search.filter === "file" ? "No files found" : "No results found"}
                  </div>
                )}
                {!search.loading && search.results.length === 0 && !search.query.trim() && search.filter !== "file" && search.filter !== "thread" && (
                  <div className="text-center text-xs text-muted-foreground py-4">
                    Type to search messages
                  </div>
                )}
                {search.filter === "thread"
                  ? search.results.map((thread) => {
                      const senderName =
                        state.userPresence[thread.sender]?.displayName ||
                        displayUserId(thread.sender);
                      const replyCount = thread.thread_reply_count ?? 0;
                      return (
                        <div
                          key={thread.event_id}
                          className="flex items-start gap-3 px-3 py-2.5 cursor-pointer hover:bg-accent/30 rounded-md transition-colors"
                          onClick={() => {
                            closeSearch();
                            openThread(thread.event_id);
                          }}
                        >
                          <MessageSquare className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate">
                              {thread.thread_name || thread.content.body}
                            </p>
                            {thread.thread_name && (
                              <p className="text-xs text-muted-foreground truncate">{thread.content.body}</p>
                            )}
                            <p className="text-xs text-muted-foreground mt-0.5">
                              {replyCount} {replyCount === 1 ? "reply" : "replies"} · by {senderName} · {formatThreadTime(thread.origin_server_ts)}
                            </p>
                          </div>
                        </div>
                      );
                    })
                  : search.results.map((msg, i) => {
                      const prev = search.results[i - 1];
                      const grouped =
                        !!prev &&
                        prev.content.msgtype !== "m.system" &&
                        msg.content.msgtype !== "m.system" &&
                        prev.sender === msg.sender &&
                        msg.origin_server_ts - prev.origin_server_ts < 60000;
                      return (
                        <div
                          key={msg.event_id}
                          className="cursor-pointer hover:bg-accent/30 rounded-md transition-colors"
                          onClick={async () => {
                            const alreadyLoaded = state.messages.some((m) => m.event_id === msg.event_id);
                            if (!alreadyLoaded && state.currentRoomId) {
                              await loadMessagesAround(state.currentRoomId, msg.origin_server_ts);
                            }
                            closeSearch();
                            setScrollToEventId(msg.event_id);
                          }}
                        >
                          <MessageItem message={msg} grouped={grouped} />
                        </div>
                      );
                    })}
              </>
            ) : mentionsOpen ? (
              <>
                {mentionsLoading && (
                  <div className="text-center text-xs text-muted-foreground py-4">
                    Loading mentions...
                  </div>
                )}
                {!mentionsLoading && mentionResults.length === 0 && (
                  <div className="text-center text-xs text-muted-foreground py-4">
                    No mentions found in this room
                  </div>
                )}
                {mentionResults.map((msg, i) => {
                  const prev = mentionResults[i - 1];
                  const grouped =
                    !!prev &&
                    prev.content.msgtype !== "m.system" &&
                    msg.content.msgtype !== "m.system" &&
                    prev.sender === msg.sender &&
                    msg.origin_server_ts - prev.origin_server_ts < 60000;
                  return (
                    <div
                      key={msg.event_id}
                      className="cursor-pointer hover:bg-accent/30 rounded-md transition-colors"
                      onClick={async () => {
                        if (!state.currentRoomId) return;
                        const msgChannelId = msg.channel_id;
                        if (msgChannelId && msgChannelId !== state.currentChannelId) {
                          // Switch to the mention's channel, then load messages around the timestamp
                          await selectChannel(msgChannelId);
                          await loadMessagesAround(state.currentRoomId, msg.origin_server_ts);
                        } else {
                          const alreadyLoaded = state.messages.some((m) => m.event_id === msg.event_id);
                          if (!alreadyLoaded) {
                            await loadMessagesAround(state.currentRoomId, msg.origin_server_ts);
                          }
                        }
                        closeMentions();
                        setScrollToEventId(msg.event_id);
                      }}
                    >
                      <MessageItem message={msg} grouped={grouped} />
                    </div>
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
                  const msgDate = new Date(msg.origin_server_ts);
                  const prevDate = prev ? new Date(prev.origin_server_ts) : null;
                  const showDateDivider =
                    !prevDate ||
                    msgDate.getFullYear() !== prevDate.getFullYear() ||
                    msgDate.getMonth() !== prevDate.getMonth() ||
                    msgDate.getDate() !== prevDate.getDate();
                  const dateLabel = msgDate.toLocaleDateString(undefined, {
                    weekday: "long",
                    month: "long",
                    day: "numeric",
                    year:
                      msgDate.getFullYear() !== new Date().getFullYear()
                        ? "numeric"
                        : undefined,
                  });
                  const showUnreadDivider = showNewDivider && msg.event_id === firstUnreadEventId;
                  return (
                    <div key={msg.event_id}>
                      {showUnreadDivider && (
                        <div ref={newDividerRef} className="flex items-center gap-2 py-1.5 px-2">
                          <div className="h-px flex-1 bg-red-500" />
                          <span className="text-xs font-semibold text-red-500 whitespace-nowrap">
                            New
                          </span>
                          <div className="h-px flex-1 bg-red-500" />
                        </div>
                      )}
                      {showDateDivider && (
                        <div className="flex items-center justify-center gap-2 py-1.5 px-2">
                          <div className="h-px flex-1 bg-border" />
                          <span className="text-xs font-medium px-2 py-0.5 rounded-full whitespace-nowrap text-muted-foreground/70 bg-muted/40">
                            {dateLabel}
                          </span>
                          <div className="h-px flex-1 bg-border" />
                        </div>
                      )}
                      <MessageItem
                        message={msg}
                        grouped={grouped}
                        triggerEdit={editingEventId === msg.event_id}
                        onEditDone={() => setEditingEventId(null)}
                      />
                    </div>
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
            onClick={() => scrollToBottom("smooth")}
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
              {state.replyingTo.content.spoiler
                ? <span className="italic">Spoiler message</span>
                : renderInlineEmojis(state.replyingTo.content.body)}
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

      {/* Typing indicator — always rendered to reserve space and prevent layout shift over reactions */}
      <div className="px-4 pb-1 flex items-center gap-1.5 h-5">
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
            <>
              <span className="flex gap-0.5">
                <span className="w-1 h-1 rounded-full bg-muted-foreground animate-bounce [animation-delay:0ms]" />
                <span className="w-1 h-1 rounded-full bg-muted-foreground animate-bounce [animation-delay:150ms]" />
                <span className="w-1 h-1 rounded-full bg-muted-foreground animate-bounce [animation-delay:300ms]" />
              </span>
              <span className="text-xs text-muted-foreground italic">{text}</span>
            </>
          );
        })()}
      </div>

      {/* Input */}
      {cliMode ? (
        <CommandBar onClose={() => setCliMode(false)} />
      ) : (() => {
        const currentRoomInfo = state.currentRoomId ? state.roomInfoMap[state.currentRoomId] : null;
        const myMember = state.roomMembers.find((m) => m.userId === state.userId);
        const myRole = myMember?.role || "member";
        const currentChannel = state.currentChannelId ? state.channels.find((c) => c.channel_id === state.currentChannelId) : null;
        const isReadOnlyForMe = (currentRoomInfo?.read_only || currentChannel?.read_only) && myRole === "member";
        if (isReadOnlyForMe) {
          return (
            <div className="border-t p-3 flex items-center justify-center text-sm text-muted-foreground">
              {currentChannel?.read_only ? "This channel" : "This room"} is read-only. Only owners and moderators can send messages.
            </div>
          );
        }
        return (
        <div className={`border-t ${isMobile ? "p-2" : "p-3"}`}>
          {/* Spoiler mode banner */}
          {isSpoiler && (
            <div className="flex items-center gap-1.5 mb-2 px-2 py-1 rounded bg-amber-500/10 text-amber-500 text-xs font-medium">
              <EyeOff className="h-3 w-3 shrink-0" />
              <span>Spoiler — message will be hidden until clicked</span>
              <button className="ml-auto hover:text-amber-400 cursor-pointer" onClick={() => setIsSpoiler(false)} title="Disable spoiler">✕</button>
            </div>
          )}
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
                      <span className="text-[10px] text-muted-foreground/70">{pf.file.size < 1024 * 1024 ? `${(pf.file.size / 1024).toFixed(1)} KB` : `${(pf.file.size / (1024 * 1024)).toFixed(1)} MB`}</span>
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
          {mediaUrls.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2">
              {mediaUrls.map((m, i) => (
                <div key={i} className="relative group">
                  {m.type === "image" ? (
                    <img
                      src={m.url}
                      alt="preview"
                      className="h-16 rounded-md border border-border object-cover"
                    />
                  ) : (
                    <div className="relative h-16 w-20 rounded-md border border-border bg-muted flex items-center justify-center">
                      <Film className="h-5 w-5 text-muted-foreground" />
                    </div>
                  )}
                  <button
                    className="absolute -top-1.5 -right-1.5 h-4 w-4 rounded-full bg-destructive text-destructive-foreground text-[10px] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer leading-none"
                    onClick={() => removeMediaUrl(m.url)}
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
                    key={`${m.kind}-${m.id}`}
                    className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm cursor-pointer transition-colors ${
                      i === selectedMentionIdx ? "bg-accent" : "hover:bg-accent/50"
                    }`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      completeMention(m.name);
                    }}
                  >
                    {m.kind === "role" ? (
                      <span
                        className="flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold"
                        style={{ backgroundColor: m.color ? `${m.color}33` : undefined, color: m.color || undefined }}
                      >
                        @
                      </span>
                    ) : (
                      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-secondary text-xs font-semibold">
                        {m.name[0]?.toUpperCase()}
                      </span>
                    )}
                    <span style={m.kind === "role" && m.color ? { color: m.color } : undefined}>{m.name}</span>
                    {m.kind === "role" && (
                      <span className="ml-auto text-xs text-muted-foreground">Role</span>
                    )}
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

            <Button
              variant="ghost"
              size="icon"
              className={`shrink-0 ${isSpoiler ? "text-amber-500 bg-amber-500/10 hover:bg-amber-500/20 hover:text-amber-400" : ""}`}
              onClick={() => setIsSpoiler(v => !v)}
              title={isSpoiler ? "Spoiler mode on — click to disable" : "Mark as spoiler"}
            >
              <EyeOff className="h-4 w-4" />
            </Button>

            <div className="relative flex-1">
              {/* Placeholder — shown when the div is empty */}
              {!input && (
                <span className="absolute top-2 left-3 text-sm text-muted-foreground pointer-events-none select-none z-10">
                  Type your message...
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
                className={`w-full rounded-lg border border-input bg-transparent px-3 py-2 pr-10 text-sm md:text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring min-h-[36px] md:min-h-[36px] max-h-40 overflow-y-auto break-words ${isMobile ? "min-h-[44px] text-base" : ""} ${displayLength > MAX_MESSAGE_LENGTH ? "ring-2 ring-destructive focus-visible:ring-destructive" : ""}`}
                style={{ wordBreak: "break-word", whiteSpace: "pre-wrap", lineHeight: isMobile ? "24px" : "20px" }}
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
              size={isMobile ? "lg" : "default"}
              disabled={displayLength > MAX_MESSAGE_LENGTH}
              className={isMobile ? "px-5 text-base" : ""}
            >
              Send
            </Button>
          </div>
        </div>
        );
      })()}
      <Dialog open={exifDialogOpen} onOpenChange={setExifDialogOpen}>
        <DialogContent className="sm:max-w-[360px]">
          <DialogHeader>
            <DialogTitle>Scrub image metadata?</DialogTitle>
            <DialogDescription>
              Your image may contain EXIF data such as GPS location, camera model, and capture time. Would you like to remove it before uploading?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button variant="outline" onClick={() => handleExifChoice(false)}>
              Keep metadata
            </Button>
            <Button onClick={() => handleExifChoice(true)}>
              Scrub EXIF
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={uploading}>
        <DialogContent
          className="sm:max-w-[300px]"
          onPointerDownOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
          showCloseButton={false}
        >
          <DialogHeader>
            <DialogTitle className="text-sm">
              {uploadProcessing ? "Processing file" : "Uploading file"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2 min-w-0 overflow-hidden">
            <p className="text-xs text-muted-foreground truncate">{uploadFileName}</p>
            {uploadProcessing ? (
              <div className="flex flex-col items-center gap-2 py-1">
                <div className="h-2 w-full bg-muted rounded-full overflow-hidden">
                  <div className="h-full bg-primary rounded-full animate-pulse w-full" />
                </div>
                <p className="text-xs text-muted-foreground text-center">
                  Server is processing your video, please wait...
                </p>
              </div>
            ) : (
              <>
                <div className="bg-muted rounded-full h-2">
                  <div
                    className="bg-primary rounded-full h-2 transition-all"
                    style={{ width: `${uploadProgress}%` }}
                  />
                </div>
                <p className="text-xs text-muted-foreground text-center">{uploadProgress}%</p>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
