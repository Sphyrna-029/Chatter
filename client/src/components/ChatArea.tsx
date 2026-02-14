import { useState, useRef, useEffect, useCallback } from "react";
import { useAppContext } from "@/lib/store";
import { MessageItem } from "./MessageItem";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

const emojiCategories: Record<string, string[]> = {
  Smileys: ["😀","😃","😄","😁","😆","😅","🤣","😂","🙂","🙃","😉","😊","😇","🥰","😍","🤩","😘","😗","😚","😙","🥲","😋","😛","😜","🤪","😝","🤑","🤗","🤭","🤫","🤔"],
  Gestures: ["👍","👎","👊","✊","🤛","🤜","🤞","✌️","🤟","🤘","👌","🤌","🤏","👈","👉","👆","👇","☝️","👋","🤚","🖐️","✋","🖖","👏","🙌","🤲","🤝","🙏"],
  Emotions: ["❤️","🧡","💛","💚","💙","💜","🖤","🤍","🤎","💔","❤️‍🔥","❤️‍🩹","💕","💞","💓","💗","💖","💘","💝","💟"],
  Nature: ["🌱","🌲","🌳","🌴","🌵","🌾","🌿","☘️","🍀","🍁","🍂","🍃","🌺","🌻","🌹","🥀","🌷","🌸","💐","🌼","⭐","🌟","✨","⚡","🔥","💧"],
  Food: ["🍕","🍔","🍟","🌭","🍿","🥓","🥚","🍳","🥞","🍞","🥐","🧀","🥗","🌮","🌯","🥪","🍖","🍗"],
  Activities: ["⚽","🏀","🏈","⚾","🎾","🏐","🏉","🎱","🏓","🏸","⛳","🏹","🥊","🥋","🎽","🛹"],
};

export function ChatArea() {
  const { state, dispatch, sendMessage, sendTyping, updateTopic } = useAppContext();
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
  const inputRef = useRef<HTMLInputElement>(null);

  // Scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [state.messages]);

  const handleSend = useCallback(async () => {
    const body = input.trim();
    if (!body || !state.currentRoomId) return;
    const replyEventId = state.replyingTo?.event_id;
    setInput("");
    dispatch({ type: "SET_REPLYING_TO", payload: null });
    await sendMessage(body, replyEventId);
  }, [input, state.currentRoomId, state.replyingTo, sendMessage, dispatch]);

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
    if (e.key === "Enter") {
      handleSend();
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
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
    <div className="flex flex-1 flex-col min-h-0">
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
      <ScrollArea className="flex-1 overflow-hidden px-2 py-2">
        <div className="space-y-0.5">
          {state.messages.map((msg) => (
            <MessageItem key={msg.event_id} message={msg} />
          ))}
          <div ref={messagesEndRef} />
        </div>
      </ScrollArea>

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

      {/* Input */}
      <div className="border-t p-3">
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

          <div className="relative flex-1">
            <Input
              ref={inputRef}
              placeholder="Type your message..."
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyPress}
              className="pr-10"
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

          <Button onClick={handleSend} size="default">
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}
