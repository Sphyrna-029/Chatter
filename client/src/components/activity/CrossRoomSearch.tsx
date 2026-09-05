import { useCallback, useRef, useState } from "react";
import { useAppContext } from "@/lib/store";
import { apiSearchMessages, type MatrixMessage } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { displayUserId } from "@/lib/utils";
import { Search, Loader2 } from "lucide-react";

interface CrossRoomSearchProps {
  onSelectRoom: (roomId: string) => void;
}

const RESULT_LIMIT = 20;

/** Search every joined room at once. The server's search is per room, so this
 *  fans out and merges — fine for a self-hosted server's handful of rooms. */
export function CrossRoomSearch({ onSelectRoom }: CrossRoomSearchProps) {
  const { state } = useAppContext();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MatrixMessage[] | null>(null);
  const [searching, setSearching] = useState(false);
  // Only the newest search may write results; a slow room must not overwrite
  // the answer to a later query.
  const searchIdRef = useRef(0);

  const runSearch = useCallback(async (raw: string) => {
    const q = raw.trim();
    if (!q) {
      setResults(null);
      return;
    }
    const id = ++searchIdRef.current;
    setSearching(true);
    try {
      const pages = await Promise.all(
        state.joinedRoomIds.map((roomId) =>
          apiSearchMessages(roomId, q, "all", "all", undefined, false, 0, RESULT_LIMIT)
            .then((page) => page.items)
            .catch(() => [] as MatrixMessage[]),
        ),
      );
      if (id !== searchIdRef.current) return;
      const merged = pages
        .flat()
        .sort((a, b) => b.origin_server_ts - a.origin_server_ts)
        .slice(0, RESULT_LIMIT);
      setResults(merged);
    } finally {
      if (id === searchIdRef.current) setSearching(false);
    }
  }, [state.joinedRoomIds]);

  return (
    <section className="space-y-3">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-muted-foreground uppercase tracking-wide">
        <Search className="h-4 w-4" />
        Search All Rooms
      </h2>
      <div className="relative">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") runSearch(query); }}
          placeholder="Search messages across every room, then press Enter"
          className="pr-8"
        />
        {searching && (
          <Loader2 className="absolute right-2.5 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
        )}
      </div>

      {results !== null && (
        results.length === 0 ? (
          <p className="text-sm text-muted-foreground py-2">
            {searching ? "Searching…" : "No messages matched."}
          </p>
        ) : (
          <div className="rounded-lg border border-border divide-y divide-border">
            {results.map((msg) => {
              const info = state.roomInfoMap[msg.room_id];
              const presence = state.userPresence[msg.sender];
              const sender = presence?.displayName || displayUserId(msg.sender);
              return (
                <button
                  key={msg.event_id}
                  onClick={() => onSelectRoom(msg.room_id)}
                  className="flex flex-col gap-0.5 w-full px-4 py-2.5 text-left transition-colors hover:bg-accent/50 cursor-pointer"
                >
                  <span className="flex items-center gap-2 text-xs text-muted-foreground min-w-0">
                    <span className="font-medium text-foreground truncate">{sender}</span>
                    <span className="truncate">in {info?.name || "unknown room"}</span>
                  </span>
                  <span className="text-sm truncate">{msg.content.body}</span>
                </button>
              );
            })}
          </div>
        )
      )}
    </section>
  );
}
