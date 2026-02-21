import { useState, useRef, useEffect, useCallback } from "react";
import { useAppContext } from "@/lib/store";
import {
  executeCommand,
  getAllCommands,
  findCommand,
  type CommandContext,
  type CommandResult,
} from "@/lib/commands";

interface CommandBarProps {
  onClose: () => void;
  initialValue?: string;
}

interface OutputEntry {
  command: string;
  result: CommandResult;
}

export function CommandBar({ onClose, initialValue = "" }: CommandBarProps) {
  const {
    state,
    createRoom,
    joinRoom,
    leaveRoom,
    selectRoom,
    getAllRooms,
    setCustomStatus,
    sendMessage,
    loadRooms,
    updateTopic,
    kickMember,
    banMember,
    unbanMember,
    setMemberRole,
    setNameColors,
  } = useAppContext();

  const [input, setInput] = useState(initialValue);
  const [outputs, setOutputs] = useState<OutputEntry[]>([]);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const [executing, setExecuting] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const outputRef = useRef<HTMLDivElement>(null);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Scroll output to bottom on new entries
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [outputs]);

  // Build command context from app context
  const buildCtx = useCallback(
    (): CommandContext => ({
      state,
      createRoom: (name: string, topic: string) => createRoom(name, topic),
      joinRoom,
      leaveRoom,
      selectRoom,
      getAllRooms,
      setCustomStatus,
      sendMessage: (body: string) => sendMessage(body),
      loadRooms,
      updateTopic,
      kickMember,
      banMember,
      unbanMember,
      setMemberRole,
      setNameColors,
    }),
    [state, createRoom, joinRoom, leaveRoom, selectRoom, getAllRooms, setCustomStatus, sendMessage, loadRooms, updateTopic, kickMember, banMember, unbanMember, setMemberRole, setNameColors]
  );

  // Autocomplete suggestions
  const suggestions = (() => {
    const trimmed = input.trim().replace(/^\//, "");
    if (!trimmed || input.includes(" ")) return [];
    return getAllCommands().filter(
      (c) =>
        c.name.startsWith(trimmed.toLowerCase()) ||
        c.aliases.some((a) => a.startsWith(trimmed.toLowerCase()))
    );
  })();

  const handleExecute = useCallback(async () => {
    const line = input.trim();
    if (!line) return;

    setHistory((prev) => [line, ...prev]);
    setHistoryIdx(-1);

    // Handle /clear specially
    if (line.replace(/^\//, "").trim().toLowerCase() === "clear" || line.replace(/^\//, "").trim().toLowerCase() === "cls") {
      setOutputs([]);
      setInput("");
      return;
    }

    setExecuting(true);
    const result = await executeCommand(line, buildCtx());
    setExecuting(false);

    setOutputs((prev) => [...prev.slice(-19), { command: line, result }]);
    setInput("");

    if (result.closeAfter) {
      setTimeout(() => onClose(), 400);
    }
  }, [input, buildCtx, onClose]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Escape — close CLI
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }

    // Tab — autocomplete
    if (e.key === "Tab" && suggestions.length > 0) {
      e.preventDefault();
      const cmd = suggestions[selectedSuggestion % suggestions.length];
      setInput(`/${cmd.name} `);
      setSelectedSuggestion(0);
      return;
    }

    // Arrow up/down — suggestions or history
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (suggestions.length > 0) {
        setSelectedSuggestion((i) => Math.min(i + 1, suggestions.length - 1));
      }
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (suggestions.length > 0) {
        setSelectedSuggestion((i) => Math.max(i - 1, 0));
      } else if (history.length > 0) {
        const newIdx = Math.min(historyIdx + 1, history.length - 1);
        setHistoryIdx(newIdx);
        setInput(history[newIdx]);
      }
      return;
    }

    // Enter — execute
    if (e.key === "Enter") {
      e.preventDefault();
      if (suggestions.length > 0 && !input.includes(" ")) {
        const cmd = suggestions[selectedSuggestion % suggestions.length];
        setInput(`/${cmd.name} `);
        setSelectedSuggestion(0);
      } else {
        handleExecute();
      }
      return;
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInput(e.target.value);
    setSelectedSuggestion(0);
    setHistoryIdx(-1);
  };

  const typeColor = (type: CommandResult["type"]) => {
    switch (type) {
      case "success": return "text-green-400";
      case "error": return "text-red-400";
      case "info": return "text-amber-300";
    }
  };

  return (
    <div className="border-t transition-all duration-200">
      {/* Output area */}
      {outputs.length > 0 && (
        <div
          ref={outputRef}
          className="max-h-48 overflow-y-auto px-3 pt-2 space-y-2 font-mono text-xs bg-black/20"
        >
          {outputs.map((entry, i) => (
            <div key={i}>
              <div className="text-muted-foreground">
                <span className="text-green-500">{">"}</span> {entry.command}
              </div>
              {entry.result.output && (
                <pre className={`whitespace-pre-wrap break-words mt-0.5 ${typeColor(entry.result.type)}`}>
                  {entry.result.output}
                </pre>
              )}
            </div>
          ))}
          {executing && (
            <div className="text-muted-foreground animate-pulse">Running...</div>
          )}
        </div>
      )}

      {/* Input area */}
      <div className="p-3">
        <div className="relative">
          {/* Autocomplete dropdown */}
          {suggestions.length > 0 && (
            <div className="absolute bottom-full left-0 mb-1 w-72 rounded-md border border-green-900/50 bg-popover p-1 shadow-lg z-50 font-mono text-xs">
              {suggestions.map((cmd, i) => (
                <button
                  key={cmd.name}
                  className={`flex w-full items-center gap-3 rounded-sm px-2 py-1.5 cursor-pointer transition-colors ${
                    i === selectedSuggestion ? "bg-green-900/30 text-green-400" : "hover:bg-accent/50 text-foreground"
                  }`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setInput(`/${cmd.name} `);
                    setSelectedSuggestion(0);
                    inputRef.current?.focus();
                  }}
                >
                  <span className="text-green-500 font-semibold">/{cmd.name}</span>
                  <span className="text-muted-foreground truncate">{cmd.description}</span>
                </button>
              ))}
            </div>
          )}

          <div className="flex items-center gap-2">
            <span className="text-green-500 font-mono text-sm font-bold select-none">{">_"}</span>
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              placeholder="Type a command... (Esc to close)"
              className="flex-1 bg-transparent font-mono text-sm text-foreground placeholder:text-muted-foreground/50 outline-none border-none"
              spellCheck={false}
              autoComplete="off"
            />
            <kbd className="hidden sm:inline-block text-[10px] text-muted-foreground/50 border border-muted-foreground/20 rounded px-1 py-0.5 font-mono">
              Esc
            </kbd>
          </div>
        </div>
      </div>
    </div>
  );
}
