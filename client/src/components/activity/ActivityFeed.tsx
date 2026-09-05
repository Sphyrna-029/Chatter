import { useEffect, useState } from "react";
import { useAppContext } from "@/lib/store";
import { apiGetActivityFeed, type ActivityEvent } from "@/lib/api";
import { AuthImage } from "@/components/AuthImage";
import { History } from "lucide-react";

interface ActivityFeedProps {
  refreshKey: number;
  onSelectRoom: (roomId: string) => void;
}

function relativeTime(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Joins, kicks, ownership changes and the like, newest first. The server
 *  stores these as ordinary messages tagged `m.system`. */
export function ActivityFeed({ refreshKey, onSelectRoom }: ActivityFeedProps) {
  const { state } = useAppContext();
  const [events, setEvents] = useState<ActivityEvent[]>([]);

  useEffect(() => {
    let cancelled = false;
    apiGetActivityFeed(20)
      .then((data) => { if (!cancelled) setEvents(data); })
      .catch(() => { /* keep whatever is on screen */ });
    return () => { cancelled = true; };
  }, [refreshKey]);

  if (events.length === 0) return null;

  return (
    <section className="space-y-3">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-muted-foreground uppercase tracking-wide">
        <History className="h-4 w-4" />
        Recent Events
      </h2>
      <div className="rounded-lg border border-border divide-y divide-border">
        {events.map((event) => {
          const info = state.roomInfoMap[event.room_id];
          const name = info?.name || "a room";
          return (
            <button
              key={event.event_id}
              onClick={() => onSelectRoom(event.room_id)}
              className="flex items-center gap-3 w-full px-4 py-2.5 text-left transition-colors hover:bg-accent/50 cursor-pointer"
            >
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent text-3xs font-bold shrink-0">
                {info?.icon_url ? (
                  <AuthImage src={info.icon_url} alt="" className="h-6 w-6 rounded-md object-cover" />
                ) : (
                  name.charAt(0).toUpperCase()
                )}
              </span>
              <span className="text-sm truncate flex-1 min-w-0">
                {event.body}
                <span className="text-muted-foreground"> · {name}</span>
              </span>
              <span className="text-xs text-muted-foreground shrink-0">
                {relativeTime(event.ts)}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
