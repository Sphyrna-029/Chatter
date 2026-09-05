import { useEffect, useState } from "react";
import { useAppContext } from "@/lib/store";
import { apiGetActivityStats, type ActivityStats as Stats } from "@/lib/api";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { AuthImage, AuthAvatarImage } from "@/components/AuthImage";
import { displayUserId } from "@/lib/utils";
import { BarChart3, Hash, TrendingUp } from "lucide-react";

interface ActivityStatsProps {
  refreshKey: number;
  onSelectRoom: (roomId: string) => void;
  onSelectUser: (userId: string) => void;
}

/** The server only emits days that carried messages. Rendering that list as-is
 *  would space an empty day out of existence and compress the time axis, so the
 *  window is rebuilt in full with the gaps filled as zero. */
function fillDays(
  daily: { date: string; count: number }[],
  days: number,
): { date: string; count: number }[] {
  const byDate = new Map(daily.map((d) => [d.date, d.count]));
  const today = new Date();
  const filled: { date: string; count: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
    filled.push({ date: key, count: byDate.get(key) ?? 0 });
  }
  return filled;
}

function shortDate(iso: string): string {
  // The server groups by its own calendar day; parse as local to avoid a
  // one-day shift when formatting.
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/** Single-series magnitude bars: one hue from the theme, values on hover
 *  rather than a label on every bar. */
function Bars({
  values,
  labelFor,
  axis,
}: {
  values: number[];
  labelFor: (index: number, value: number) => string;
  axis: { index: number; text: string }[];
}) {
  const max = Math.max(1, ...values);
  return (
    <div className="space-y-1">
      <div
        className="flex items-end gap-[2px] h-16 border-b border-border"
        role="img"
      >
        {values.map((value, i) => (
          <div
            key={i}
            title={labelFor(i, value)}
            className="flex-1 min-w-0 flex items-end h-full"
          >
            <div
              className="w-full rounded-t-sm bg-primary/70 hover:bg-primary transition-colors"
              // A zero day is drawn as nothing against the baseline rather
              // than a stub, which would read as a small non-zero value.
              style={{ height: value === 0 ? 0 : `${Math.max(6, (value / max) * 100)}%` }}
            />
          </div>
        ))}
      </div>
      <div className="relative h-3">
        {axis.map(({ index, text }) => {
          const centre = ((index + 0.5) / values.length) * 100;
          // Pull the end labels inside the box; centring them would hang the
          // first off the left edge and the last off the right.
          const atStart = centre < 10;
          const atEnd = centre > 90;
          return (
            <span
              key={index}
              className={`absolute text-3xs text-muted-foreground whitespace-nowrap ${
                atStart || atEnd ? "" : "-translate-x-1/2"
              }`}
              style={atEnd ? { right: 0 } : { left: atStart ? 0 : `${centre}%` }}
            >
              {text}
            </span>
          );
        })}
      </div>
    </div>
  );
}

export function ActivityStats({ refreshKey, onSelectRoom, onSelectUser }: ActivityStatsProps) {
  const { state } = useAppContext();
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiGetActivityStats()
      .then((data) => { if (!cancelled) setStats(data); })
      .catch(() => { /* keep the previous figures rather than blanking them */ });
    return () => { cancelled = true; };
  }, [refreshKey]);

  if (!stats || stats.total === 0) return null;

  const daily = fillDays(stats.daily, stats.window_days);
  const dailyCounts = daily.map((d) => d.count);
  const busiestHour = stats.hourly.indexOf(Math.max(...stats.hourly));

  return (
    <section className="space-y-4 rounded-lg border border-border p-4">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          <TrendingUp className="h-4 w-4" />
          Last {stats.window_days} days
        </h2>
        <p className="text-xs text-muted-foreground">
          busiest around {busiestHour.toString().padStart(2, "0")}:00
        </p>
      </div>

      <div className="flex items-baseline gap-2">
        <span className="text-3xl font-bold tabular-nums">{stats.total.toLocaleString()}</span>
        <span className="text-sm text-muted-foreground">
          messages · {stats.mine.toLocaleString()} from you
        </span>
      </div>

      {dailyCounts.length > 1 && (
        <div className="space-y-1">
          <h3 className="text-xs font-medium text-muted-foreground">Messages per day</h3>
          <Bars
            values={dailyCounts}
            labelFor={(i, v) => `${shortDate(daily[i].date)} — ${v} message${v !== 1 ? "s" : ""}`}
            axis={[
              { index: 0, text: shortDate(daily[0].date) },
              { index: dailyCounts.length - 1, text: shortDate(daily[dailyCounts.length - 1].date) },
            ]}
          />
        </div>
      )}

      <div className="space-y-1">
        <h3 className="text-xs font-medium text-muted-foreground">Messages by hour</h3>
        <Bars
          values={stats.hourly}
          labelFor={(h, v) => `${h.toString().padStart(2, "0")}:00 — ${v} message${v !== 1 ? "s" : ""}`}
          axis={[
            { index: 0, text: "00" },
            { index: 6, text: "06" },
            { index: 12, text: "12" },
            { index: 18, text: "18" },
          ]}
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-1">
        {stats.top_people.length > 0 && (
          <div className="space-y-2">
            <h3 className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <BarChart3 className="h-3.5 w-3.5" />
              Top people
            </h3>
            <div className="space-y-1">
              {stats.top_people.map((person, i) => {
                const presence = state.userPresence[person.user_id];
                const name = presence?.displayName || displayUserId(person.user_id);
                return (
                  <button
                    key={person.user_id}
                    onClick={() => onSelectUser(person.user_id)}
                    className="flex items-center gap-2.5 w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/50 cursor-pointer"
                  >
                    <span className="text-xs text-muted-foreground w-4 text-right shrink-0">{i + 1}</span>
                    <Avatar className="h-6 w-6 shrink-0">
                      <AuthAvatarImage src={presence?.avatarUrl || ""} />
                      <AvatarFallback className="text-3xs bg-secondary">
                        {name[0]?.toUpperCase() || "?"}
                      </AvatarFallback>
                    </Avatar>
                    <span className="text-sm font-medium truncate flex-1">{name}</span>
                    <span className="text-xs text-muted-foreground shrink-0 tabular-nums">
                      {person.count}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {stats.top_rooms.length > 0 && (
          <div className="space-y-2">
            <h3 className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <Hash className="h-3.5 w-3.5" />
              Most active rooms
            </h3>
            <div className="space-y-1">
              {stats.top_rooms.map((room, i) => {
                const info = state.roomInfoMap[room.room_id];
                const name = info?.name || "Unnamed";
                return (
                  <button
                    key={room.room_id}
                    onClick={() => onSelectRoom(room.room_id)}
                    className="flex items-center gap-2.5 w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/50 cursor-pointer"
                  >
                    <span className="text-xs text-muted-foreground w-4 text-right shrink-0">{i + 1}</span>
                    <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent text-3xs font-bold shrink-0">
                      {info?.icon_url ? (
                        <AuthImage src={info.icon_url} alt="" className="h-6 w-6 rounded-md object-cover" />
                      ) : (
                        name.charAt(0).toUpperCase()
                      )}
                    </span>
                    <span className="text-sm font-medium truncate flex-1">{name}</span>
                    <span className="text-xs text-muted-foreground shrink-0 tabular-nums">
                      {room.count}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
