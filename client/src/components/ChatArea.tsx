import { useState, useRef, useEffect, useLayoutEffect, useCallback } from "react";
import { useAppContext } from "@/lib/store";
import { apiUploadFile } from "@/lib/api";
import { MessageItem } from "./MessageItem";
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

const MAX_MESSAGE_LENGTH = 4000;

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

export function ChatArea() {
  const { state, dispatch, sendMessage, sendTyping, updateTopic, loadOlderMessages } = useAppContext();
  const [input, setInput] = useState("");
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionSearch, setMentionSearch] = useState("");
  const [mentionStart, setMentionStart] = useState(-1);
  const [selectedMentionIdx, setSelectedMentionIdx] = useState(0);
  const [editingTopic, setEditingTopic] = useState(false);
  const [topicDraft, setTopicDraft] = useState("");
  const topicInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollWrapperRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const prevScrollHeightRef = useRef<number>(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadFileName, setUploadFileName] = useState("");
  const [cliMode, setCliMode] = useState(false);

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
      isNearBottomRef.current = scrollHeight - scrollTop - clientHeight < 100;
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
    const body = input.trim();
    const hasFiles = pendingFiles.length > 0;
    if (!body && !hasFiles) return;
    if (!state.currentRoomId) return;
    if (body.length > MAX_MESSAGE_LENGTH) return;
    const replyEventId = state.replyingTo?.event_id;
    setInput("");
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
      await sendMessage(body, replyEventId);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
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
    if (e.key === "Escape" && state.replyingTo) {
      dispatch({ type: "SET_REPLYING_TO", payload: null });
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;

    // Detect slash at start to enter CLI mode
    if (value === "/" && !cliMode) {
      setCliMode(true);
      setInput("");
      return;
    }

    setInput(value);
    sendTyping();

    // Mention detection
    const cursorPos = e.target.selectionStart ?? value.length;
    const before = value.substring(0, cursorPos);
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
  };

  const completeMention = (username: string) => {
    if (!username) return;
    const before = input.substring(0, mentionStart);
    const after = input.substring(
      (inputRef.current?.selectionStart ?? input.length)
    );
    setInput(`${before}@${username} ${after}`);
    setMentionOpen(false);
    inputRef.current?.focus();
  };

  const insertEmoji = (emoji: string) => {
    setInput((prev) => prev + emoji);
    setEmojiOpen(false);
    inputRef.current?.focus();
  };

  // Auto-focus the input whenever the user clicks reply on a message
  useEffect(() => {
    if (state.replyingTo) {
      inputRef.current?.focus();
    }
  }, [state.replyingTo]);

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

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = e.clipboardData?.files;
    if (files && files.length > 0) {
      e.preventDefault();
      Array.from(files).forEach(addPendingFile);
    }
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

  // Auto-resize textarea vertically as content grows
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

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
  }, [state.currentRoomId]);

  const mentionMatches = mentionOpen
    ? state.roomMembers
        .filter((m) =>
          m.displayName.toLowerCase().startsWith(mentionSearch.toLowerCase())
        )
        .slice(0, 5)
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
      </div>

      {/* Messages */}
      <div ref={scrollWrapperRef} className="flex-1 overflow-hidden">
        <ScrollArea className="h-full px-2 py-2">
          <div>
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
          </div>
        </ScrollArea>
      </div>

      {/* Reply preview */}
      {state.replyingTo && (
        <div className="border-t border-l-2 border-l-primary mx-3 mt-2 px-3 py-2 bg-accent/30 rounded-sm flex items-center justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-primary">
              Replying to {state.replyingTo.sender.split(":")[0].substring(1)}
            </p>
            <p className="text-xs text-muted-foreground truncate">
              {state.replyingTo.content.body}
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
          return member?.displayName || uid.split(":")[0].substring(1);
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
          {input.length > MAX_MESSAGE_LENGTH * 0.75 && (
            <div className="flex justify-end mb-1">
              <span
                className={`text-xs font-mono px-1.5 py-0.5 rounded ${
                  input.length > MAX_MESSAGE_LENGTH
                    ? "bg-destructive/20 text-destructive font-semibold"
                    : input.length > MAX_MESSAGE_LENGTH * 0.9
                    ? "text-orange-400"
                    : "text-muted-foreground"
                }`}
              >
                {input.length}/{MAX_MESSAGE_LENGTH}
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
              <textarea
                ref={inputRef}
                placeholder="Type your message... (/ for commands, Ctrl+O for CLI)"
                value={input}
                onChange={handleInputChange}
                onKeyDown={handleKeyPress}
                onPaste={handlePaste}
                rows={1}
                className={`flex w-full rounded-md border border-input bg-transparent px-3 py-2 pr-10 text-sm shadow-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 resize-none max-h-40 overflow-y-auto ${input.length > MAX_MESSAGE_LENGTH ? "ring-2 ring-destructive focus-visible:ring-destructive" : ""}`}

              />

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
                  className="w-72 max-h-64 overflow-y-auto p-3"
                >
                  {(() => {
                    const roomCustomEmojis = state.currentRoomId
                      ? (state.roomInfoMap[state.currentRoomId]?.custom_emojis ?? [])
                      : [];
                    return roomCustomEmojis.length > 0 ? (
                      <div className="mb-3">
                        <p className="text-xs uppercase tracking-wider text-muted-foreground font-semibold mb-1">
                          Room
                        </p>
                        <div className="grid grid-cols-8 gap-0.5">
                          {roomCustomEmojis.map((e) => (
                            <button
                              key={e}
                              className="p-1 rounded hover:bg-accent transition-colors cursor-pointer hover:scale-110 flex items-center justify-center"
                              onClick={() => insertEmoji(e)}
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
                    ) : null;
                  })()}
                  {Object.entries(emojiCategories).map(([cat, emojis]) => (
                    <div key={cat} className="mb-3">
                      <p className="text-xs uppercase tracking-wider text-muted-foreground font-semibold mb-1">
                        {cat}
                      </p>
                      <div className="grid grid-cols-8 gap-0.5">
                        {emojis.map((e) => (
                          <button
                            key={e}
                            className="p-1 text-lg rounded hover:bg-accent transition-colors cursor-pointer hover:scale-110"
                            onClick={() => insertEmoji(e)}
                          >
                            {e}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </PopoverContent>
              </Popover>
            </div>

            <Button
              onClick={handleSend}
              size="default"
              disabled={input.length > MAX_MESSAGE_LENGTH}
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
