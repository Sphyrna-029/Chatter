import { useState } from "react";
import { Bell, BellOff, BellRing, Check, Smartphone } from "lucide-react";
import { useAppContext } from "@/lib/store";
import { cn } from "@/lib/utils";
import {
  notificationPermission,
  requestNotificationPermission,
  resolveNotificationLevel,
  settingsKey,
  type NotificationLevel,
} from "@/lib/notifications";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { disablePush, enablePush, pushEnabled, pushSupport } from "@/lib/push";

const LEVELS: { value: NotificationLevel; label: string; hint: string }[] = [
  { value: "all", label: "All messages", hint: "Notify for every message" },
  { value: "mentions", label: "Only @mentions", hint: "Notify when you're mentioned" },
  { value: "none", label: "Nothing", hint: "Never notify" },
];

/**
 * Notification level picker for a room, or for one channel within it.
 *
 * Channel scope offers an extra "Use room default" entry — the absence of an
 * override rather than a stored value.
 */
export function NotificationSettingsPopover({
  roomId,
  channelId,
  children,
}: {
  roomId: string;
  /** Omit for the room-wide setting. */
  channelId?: string;
  children: React.ReactNode;
}) {
  const { state, setNotificationLevel } = useAppContext();
  const [permission, setPermission] = useState(() => notificationPermission());
  const [support] = useState(() => pushSupport());
  const [pushOn, setPushOn] = useState(() => pushEnabled());
  const [pushBusy, setPushBusy] = useState(false);

  // Enrolment is per browser, not per room — it is offered here because this
  // is where someone is already thinking about being notified, and because the
  // permission prompt needs the user gesture a click in here provides.
  const togglePush = async () => {
    setPushBusy(true);
    try {
      if (pushOn) {
        await disablePush();
        setPushOn(false);
        return;
      }
      const result = await enablePush();
      setPermission(result === "unsupported" ? "unsupported" : result);
      setPushOn(result === "granted");
    } catch {
      setPushOn(false);
    } finally {
      setPushBusy(false);
    }
  };

  const effective = resolveNotificationLevel(state.notificationSettings, roomId, channelId);
  const hasOverride = channelId
    ? state.notificationSettings[settingsKey(roomId, channelId)] !== undefined
    : state.notificationSettings[settingsKey(roomId, "")] !== undefined;

  const apply = (level: NotificationLevel | "default") => {
    void setNotificationLevel(roomId, level, channelId).catch(() => {});
  };

  return (
    <Popover>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent side="right" align="start" className="w-60 p-1">
        <div className="px-2 py-1 text-3xs uppercase tracking-wide text-muted-foreground">
          {channelId ? "Channel notifications" : "Room notifications"}
        </div>

        {channelId && (
          <button
            className="w-full text-left px-2 py-1.5 rounded-sm hover:bg-muted transition-colors flex items-center gap-2 text-sm"
            onClick={() => apply("default")}
          >
            <span className="w-4 flex justify-center">
              {!hasOverride && <Check className="h-3.5 w-3.5" />}
            </span>
            <span className="flex-1">Use room default</span>
          </button>
        )}

        {LEVELS.map(({ value, label, hint }) => {
          // With no channel override the room's level is inherited, not chosen,
          // so nothing is ticked until the user picks one here.
          const selected = channelId ? hasOverride && effective === value : effective === value;
          return (
            <button
              key={value}
              className="w-full text-left px-2 py-1.5 rounded-sm hover:bg-muted transition-colors flex items-center gap-2 text-sm"
              onClick={() => apply(value)}
              title={hint}
            >
              <span className="w-4 flex justify-center">
                {selected && <Check className="h-3.5 w-3.5" />}
              </span>
              <span className="flex-1">{label}</span>
              {value === "all" && <BellRing className="h-3.5 w-3.5 text-muted-foreground" />}
              {value === "mentions" && <Bell className="h-3.5 w-3.5 text-muted-foreground" />}
              {value === "none" && <BellOff className="h-3.5 w-3.5 text-muted-foreground" />}
            </button>
          );
        })}

        {/* The browser prompt only opens from a user gesture, so it lives on a
            button rather than firing on mount. */}
        {permission === "default" && (
          <div className="mt-1 border-t pt-1">
            <button
              className="w-full text-left px-2 py-1.5 rounded-sm hover:bg-muted transition-colors text-xs text-muted-foreground"
              onClick={async () => setPermission(await requestNotificationPermission())}
            >
              Enable desktop notifications…
            </button>
          </div>
        )}
        {permission === "denied" && (
          <div className="mt-1 border-t pt-1 px-2 py-1.5 ui-meta">
            Desktop notifications are blocked in your browser settings.
          </div>
        )}
        {permission === "unsupported" && (
          <div className="mt-1 border-t pt-1 px-2 py-1.5 ui-meta">
            This browser doesn't support desktop notifications.
          </div>
        )}

        {/* Push is what reaches this device when Chatter isn't open at all.
            The levels above still apply — a muted channel stays muted here. */}
        <div className="mt-1 border-t pt-1">
          {support === "supported" && permission !== "denied" && (
            <button
              className="w-full text-left px-2 py-1.5 rounded-sm hover:bg-muted transition-colors flex items-center gap-2 text-sm disabled:opacity-50"
              onClick={togglePush}
              disabled={pushBusy}
              title="Receive notifications on this device when Chatter is closed"
            >
              <span className="w-4 flex justify-center">
                {pushOn && <Check className="h-3.5 w-3.5" />}
              </span>
              <span className="flex-1">Notify when closed</span>
              <Smartphone className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          )}
          {support === "needs-install" && (
            <div className="px-2 py-1.5 ui-meta">
              Add Chatter to your home screen to get notifications when it's closed.
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** The bell that matches a scope's current level, for use as a trigger. */
export function NotificationBell({
  level,
  className,
}: {
  level: NotificationLevel;
  className?: string;
}) {
  const Icon = level === "none" ? BellOff : level === "mentions" ? Bell : BellRing;
  return <Icon className={cn("h-3.5 w-3.5", level === "none" && "text-muted-foreground", className)} />;
}
