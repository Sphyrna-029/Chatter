import { useCallback, useEffect, useMemo, useState } from "react";
import { useAppContext } from "@/lib/store";
import { apiListRsvps, type RoomEvent, type RsvpStatus } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { AuthAvatarImage, AuthImage } from "@/components/AuthImage";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  CalendarPlus,
  CalendarDays,
  Check,
  ChevronDown,
  Bell,
  Download,
  HelpCircle,
  MapPin,
  MoreVertical,
  Pencil,
  Trash2,
  Volume2,
  X,
} from "lucide-react";
import { cn, displayUserId } from "@/lib/utils";
import { can } from "@/lib/permissions";
import { useIsMobile } from "@/hooks/use-mobile";
import { useConfirm } from "@/components/ConfirmDialog";
import { toast } from "sonner";
import {
  REMINDER_LEAD_MINUTES,
  absoluteLabel,
  dayLabel,
  phaseOf,
  relativeLabel,
  timeRangeLabel,
  toIcs,
  type EventPhase,
} from "@/lib/eventTime";
import { EventDialog } from "./EventDialog";

/** The countdown is the point of the panel, so it has to move on its own.
 *  A minute is as fine as any of the labels ever get. */
const TICK_MS = 60_000;

const RSVP_CHOICES: { status: RsvpStatus; label: string; short: string }[] = [
  { status: "going", label: "Going", short: "Going" },
  { status: "maybe", label: "Maybe", short: "Maybe" },
  { status: "declined", label: "Can't make it", short: "Declined" },
];

function PhaseBadge({ phase }: { phase: EventPhase }) {
  if (phase === "live") {
    return (
      <span className="flex items-center gap-1 rounded-full bg-success/15 px-1.5 py-0.5 text-3xs font-semibold uppercase tracking-wide text-success">
        <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse" />
        Live
      </span>
    );
  }
  if (phase === "soon") {
    return (
      <span className="rounded-full bg-warning/15 px-1.5 py-0.5 text-3xs font-semibold uppercase tracking-wide text-warning">
        Soon
      </span>
    );
  }
  return null;
}

/** The faces of the first few people coming, with the rest as a count. */
function GoingPile({ userIds, total }: { userIds: string[]; total: number }) {
  const { state } = useAppContext();
  if (total === 0) return <span className="ui-hint">Nobody yet</span>;
  const shown = userIds.slice(0, 5);
  return (
    <span className="flex items-center gap-1.5 min-w-0">
      <span className="flex items-center -space-x-1.5 shrink-0">
        {shown.map((id) => {
          const presence = state.userPresence[id];
          const label = presence?.displayName || displayUserId(id);
          return (
            <Avatar key={id} className="h-5 w-5 border-2 border-background" title={label}>
              <AuthAvatarImage src={presence?.avatarUrl || ""} />
              <AvatarFallback className="text-3xs bg-secondary">
                {label[0]?.toUpperCase() || "?"}
              </AvatarFallback>
            </Avatar>
          );
        })}
      </span>
      <span className="ui-hint truncate">
        {total} going
      </span>
    </span>
  );
}

/** The full guest list, fetched only when someone asks for it — the listing
 *  ships a handful of ids per event, not everyone's. */
function GuestList({ roomId, eventId }: { roomId: string; eventId: string }) {
  const { state } = useAppContext();
  const [lists, setLists] = useState<{ going: string[]; maybe: string[]; declined: string[] } | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    apiListRsvps(roomId, eventId)
      .then((data) => { if (!cancelled) setLists(data); })
      .catch(() => { if (!cancelled) setLists({ going: [], maybe: [], declined: [] }); });
    return () => { cancelled = true; };
  }, [roomId, eventId]);

  if (!lists) return <p className="ui-hint px-1 py-2">Loading…</p>;

  const sections: [string, string[]][] = [
    ["Going", lists.going],
    ["Maybe", lists.maybe],
    ["Can't make it", lists.declined],
  ];
  if (sections.every(([, ids]) => ids.length === 0)) {
    return <p className="ui-hint px-1 py-2">Nobody has answered yet.</p>;
  }

  return (
    <div className="space-y-2 pt-1">
      {sections.map(([title, ids]) =>
        ids.length === 0 ? null : (
          <div key={title} className="space-y-1">
            <p className="ui-heading">
              {title} — {ids.length}
            </p>
            <div className="flex flex-wrap gap-1">
              {ids.map((id) => {
                const presence = state.userPresence[id];
                const label = presence?.displayName || displayUserId(id);
                return (
                  <span
                    key={id}
                    className="flex items-center gap-1.5 rounded-full bg-accent/60 py-0.5 pl-0.5 pr-2 text-xs min-w-0"
                  >
                    <Avatar className="h-4 w-4 shrink-0">
                      <AuthAvatarImage src={presence?.avatarUrl || ""} />
                      <AvatarFallback className="text-3xs bg-secondary">
                        {label[0]?.toUpperCase() || "?"}
                      </AvatarFallback>
                    </Avatar>
                    <span className="truncate max-w-[9rem]">{label}</span>
                  </span>
                );
              })}
            </div>
          </div>
        ),
      )}
    </div>
  );
}

function EventCard({
  event,
  now,
  onEdit,
}: {
  event: RoomEvent;
  now: number;
  onEdit: (event: RoomEvent) => void;
}) {
  const { state, setRsvp, deleteEvent, updateEvent, selectChannel } = useAppContext();
  const confirm = useConfirm();
  const [expanded, setExpanded] = useState(false);

  const phase = phaseOf(event, now);
  const past = phase === "ended";
  const channel = state.channels.find((c) => c.channel_id === event.channel_id);
  // The person who scheduled it can always tend it; manage_events covers the rest.
  const mine = event.creator === state.userId;
  const canEdit = mine || can(state, "manage_events");
  const creator =
    state.userPresence[event.creator]?.displayName || displayUserId(event.creator);

  const answer = useCallback(
    async (status: RsvpStatus) => {
      // Pressing the answer you already gave withdraws it, the way a toggle
      // is expected to behave.
      const next = event.my_rsvp === status ? "" : status;
      try {
        await setRsvp(event.event_id, next);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not save your answer");
      }
    },
    [event.event_id, event.my_rsvp, setRsvp],
  );

  function downloadIcs() {
    const blob = new Blob([toIcs(event)], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${event.name.replace(/[^\w\s-]/g, "").trim() || "event"}.ics`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function cancelEvent() {
    if (
      await confirm({
        title: `Cancel "${event.name}"?`,
        description:
          "It stays in the list marked cancelled, so everyone who said they were coming finds out.",
        confirmLabel: "Cancel event",
        destructive: true,
      })
    ) {
      try {
        await updateEvent(event.event_id, { cancelled: true });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not cancel the event");
      }
    }
  }

  async function removeEvent() {
    if (
      await confirm({
        title: `Delete "${event.name}"?`,
        description: "This removes it and everyone's answers for good.",
        confirmLabel: "Delete",
        destructive: true,
      })
    ) {
      try {
        await deleteEvent(event.event_id);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not delete the event");
      }
    }
  }

  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border transition-colors",
        phase === "live" ? "border-success/40 bg-success/5" : "border-border",
        (past || event.cancelled) && "opacity-60",
      )}
    >
      {event.cover_url && (
        <AuthImage
          src={event.cover_url}
          alt=""
          className="aspect-[3/1] w-full object-cover"
        />
      )}
      <div className="px-3 py-2.5">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <PhaseBadge phase={event.cancelled ? "ended" : phase} />
            {event.cancelled && (
              <span className="rounded-full bg-destructive/15 px-1.5 py-0.5 text-3xs font-semibold uppercase tracking-wide text-destructive">
                Cancelled
              </span>
            )}
            <span
              className={cn(
                "text-sm font-medium break-words",
                event.cancelled && "line-through",
              )}
            >
              {event.name}
            </span>
          </div>

          <p className="ui-hint mt-0.5" title={absoluteLabel(event.starts_at)}>
            {timeRangeLabel(event)}
            {!event.cancelled && ` · ${relativeLabel(event, now)}`}
          </p>

          {(channel || event.location) && (
            <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground min-w-0">
              {channel ? (
                <>
                  <Volume2 className="h-3 w-3 shrink-0" />
                  <button
                    onClick={() => selectChannel(channel.channel_id)}
                    className="truncate hover:text-foreground hover:underline cursor-pointer"
                  >
                    {channel.name}
                  </button>
                </>
              ) : (
                <>
                  <MapPin className="h-3 w-3 shrink-0" />
                  <span className="truncate">{event.location}</span>
                </>
              )}
            </p>
          )}
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors cursor-pointer"
              aria-label={`Options for ${event.name}`}
            >
              <MoreVertical className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onClick={downloadIcs}>
              <Download className="h-3.5 w-3.5 mr-2" /> Add to calendar
            </DropdownMenuItem>
            {canEdit && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => onEdit(event)}>
                  <Pencil className="h-3.5 w-3.5 mr-2" /> Edit
                </DropdownMenuItem>
                {!event.cancelled && !past && (
                  <DropdownMenuItem onClick={cancelEvent}>
                    <X className="h-3.5 w-3.5 mr-2" /> Cancel event
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem className="text-destructive" onClick={removeEvent}>
                  <Trash2 className="h-3.5 w-3.5 mr-2" /> Delete
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* A cancelled or finished event is a record, not an invitation, so it
          keeps its guest list but loses the buttons. */}
      {!past && !event.cancelled && (
        <div className="mt-2 flex gap-1">
          {RSVP_CHOICES.map(({ status, label }) => {
            const active = event.my_rsvp === status;
            return (
              <Button
                key={status}
                size="sm"
                variant={active ? "secondary" : "outline"}
                className={cn(
                  "h-7 flex-1 text-2xs",
                  active && status === "going" && "text-success border-success/40",
                  active && status === "declined" && "text-muted-foreground",
                )}
                aria-pressed={active}
                onClick={() => answer(status)}
              >
                {active && status === "going" && <Check className="h-3 w-3" />}
                {active && status === "maybe" && <HelpCircle className="h-3 w-3" />}
                {active && status === "declined" && <X className="h-3 w-3" />}
                {label}
              </Button>
            );
          })}
        </div>
      )}

      {!past && !event.cancelled && (event.my_rsvp === "going" || event.my_rsvp === "maybe") && (
        <p className="ui-hint mt-1.5 flex items-center gap-1">
          <Bell className="h-3 w-3 shrink-0" />
          We'll remind you {REMINDER_LEAD_MINUTES} minutes before.
        </p>
      )}

      <button
        onClick={() => setExpanded((o) => !o)}
        className="mt-2 flex w-full items-center gap-2 text-left cursor-pointer"
        aria-expanded={expanded}
      >
        <GoingPile userIds={event.going_preview} total={event.going_count} />
        {event.maybe_count > 0 && (
          <span className="ui-hint shrink-0">· {event.maybe_count} maybe</span>
        )}
        <ChevronDown
          className={cn(
            "ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-180",
          )}
        />
      </button>

      {expanded && (
        <div className="mt-1 border-t pt-2">
          {event.description && (
            <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
              {event.description}
            </p>
          )}
          <p className="ui-hint mt-1">Scheduled by {creator}</p>
          {state.currentRoomId && (
            <GuestList roomId={state.currentRoomId} eventId={event.event_id} />
          )}
        </div>
      )}
      </div>
    </div>
  );
}

/**
 * The room's events, beside the timeline rather than over it — an event is
 * usually being discussed in the same breath as it is being arranged.
 */
export function EventsPanel({ onClose }: { onClose: () => void }) {
  const { state, loadEvents } = useAppContext();
  const isMobile = useIsMobile();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<RoomEvent | null>(null);
  const [showPast, setShowPast] = useState(false);
  // Re-rendered on a timer so "Starts in 3 minutes" is not a lie by the time
  // anyone reads it.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);

  // Opening the panel is the moment to be sure the list is current: the room
  // switch loaded it, but that may have been a long conversation ago.
  useEffect(() => { void loadEvents(); }, [loadEvents]);

  const canCreate = can(state, "manage_events");

  const { upcoming, past, upcomingCount } = useMemo(() => {
    const up: RoomEvent[] = [];
    const done: RoomEvent[] = [];
    for (const event of state.roomEvents) {
      (phaseOf(event, now) === "ended" ? done : up).push(event);
    }
    const liveCount = up.filter((e) => !e.cancelled).length;
    up.sort((a, b) => a.starts_at - b.starts_at);
    done.sort((a, b) => b.starts_at - a.starts_at);
    return { upcoming: up, past: done, upcomingCount: liveCount };
  }, [state.roomEvents, now]);

  function openCreate() {
    setEditing(null);
    setDialogOpen(true);
  }

  function openEdit(event: RoomEvent) {
    setEditing(event);
    setDialogOpen(true);
  }

  /** Events under the day they fall on, so a week reads as a week. */
  function renderGrouped(events: RoomEvent[]) {
    const out: React.ReactNode[] = [];
    let lastDay = "";
    for (const event of events) {
      const day = dayLabel(event.starts_at, now);
      if (day !== lastDay) {
        out.push(
          <p key={`day:${day}:${event.event_id}`} className="ui-heading pt-1 first:pt-0">
            {day}
          </p>,
        );
        lastDay = day;
      }
      out.push(
        <EventCard key={event.event_id} event={event} now={now} onEdit={openEdit} />,
      );
    }
    return out;
  }

  return (
    <aside
      className={
        isMobile
          ? "absolute inset-0 z-30 flex flex-col bg-background"
          : "flex w-[22rem] shrink-0 flex-col border-l bg-background min-h-0"
      }
      aria-label="Events"
    >
      <div className="flex items-center justify-between border-b px-3 py-2 shrink-0">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          <CalendarDays className="h-3.5 w-3.5 text-muted-foreground" />
          Events
          {upcomingCount > 0 && (
            <span className="text-xs text-muted-foreground">({upcomingCount})</span>
          )}
        </span>
        <div className="flex items-center gap-1">
          {canCreate && (
            <button
              onClick={openCreate}
              className="text-muted-foreground hover:text-foreground cursor-pointer"
              title="Schedule an event"
              aria-label="Schedule an event"
            >
              <CalendarPlus className="h-4 w-4" />
            </button>
          )}
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground cursor-pointer"
            title="Close panel"
            aria-label="Close panel"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <ScrollArea className="flex-1 min-w-0">
        <div className="space-y-2 p-3">
          {upcoming.length === 0 && past.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
              <CalendarDays className="h-8 w-8 text-muted-foreground/40" />
              <p className="text-sm font-medium">Nothing scheduled</p>
              <p className="ui-hint">
                {canCreate
                  ? "Put something in the calendar and the room will see it here."
                  : "When someone schedules something, it shows up here."}
              </p>
              {canCreate && (
                <Button size="sm" variant="outline" className="mt-1 h-7 text-xs" onClick={openCreate}>
                  <CalendarPlus className="h-3.5 w-3.5" />
                  Schedule an event
                </Button>
              )}
            </div>
          ) : (
            <>
              {upcoming.length === 0 ? (
                <p className="ui-hint py-4 text-center">Nothing coming up.</p>
              ) : (
                renderGrouped(upcoming)
              )}

              {past.length > 0 && (
                <div className="pt-2">
                  <button
                    onClick={() => setShowPast((o) => !o)}
                    className="flex w-full items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                    aria-expanded={showPast}
                  >
                    <ChevronDown
                      className={cn("h-3.5 w-3.5 transition-transform", showPast && "rotate-180")}
                    />
                    {past.length} past event{past.length === 1 ? "" : "s"}
                  </button>
                  {showPast && <div className="space-y-2 pt-2">{renderGrouped(past)}</div>}
                </div>
              )}
            </>
          )}
        </div>
      </ScrollArea>

      <EventDialog open={dialogOpen} onOpenChange={setDialogOpen} event={editing} />
    </aside>
  );
}
