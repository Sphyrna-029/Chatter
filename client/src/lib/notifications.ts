/**
 * Desktop notification policy.
 *
 * The server sends every message a member is entitled to see; these rules
 * decide only whether one becomes a desktop notification. Keeping the decision
 * pure makes it testable without a browser.
 */

export type NotificationLevel = "all" | "mentions" | "none";

/** Levels keyed by `${room_id}|${channel_id}`; a room-wide entry uses an empty channel. */
export type NotificationSettings = Record<string, NotificationLevel>;

/** Applied when neither the channel nor its room has an explicit setting. */
export const DEFAULT_NOTIFICATION_LEVEL: NotificationLevel = "all";

export function settingsKey(roomId: string, channelId?: string | null): string {
  return `${roomId}|${channelId ?? ""}`;
}

/**
 * A channel override wins over its room's setting, which wins over the default.
 * An explicit room-level "none" is therefore still overridable per channel —
 * muting a room but keeping one channel loud is the common case.
 */
export function resolveNotificationLevel(
  settings: NotificationSettings,
  roomId: string,
  channelId?: string | null,
): NotificationLevel {
  if (channelId) {
    const channelLevel = settings[settingsKey(roomId, channelId)];
    if (channelLevel) return channelLevel;
  }
  return settings[settingsKey(roomId, "")] ?? DEFAULT_NOTIFICATION_LEVEL;
}

export interface NotifyDecision {
  level: NotificationLevel;
  isMention: boolean;
  /** DMs bypass "all vs mentions": a direct message is always addressed to you. */
  isDm: boolean;
  /** True when the user is already looking at this exact channel in a focused tab. */
  isViewing: boolean;
  /** The user's own presence; "dnd" suppresses everything. */
  presence?: string;
}

/** Whether a newly arrived message should raise a desktop notification. */
export function shouldNotify({
  level,
  isMention,
  isDm,
  isViewing,
  presence,
}: NotifyDecision): boolean {
  if (presence === "dnd") return false;
  // Already on screen — a notification would only duplicate what they can see.
  if (isViewing) return false;
  if (level === "none") return false;
  if (level === "mentions") return isMention || isDm;
  return true;
}

/** Current browser permission, or "unsupported" where the API is absent. */
export function notificationPermission(): NotificationPermission | "unsupported" {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return Notification.permission;
}

/** Must be called from a user gesture, or browsers reject the prompt. */
export async function requestNotificationPermission(): Promise<
  NotificationPermission | "unsupported"
> {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

export interface DesktopNotification {
  title: string;
  body: string;
  icon?: string;
  /** Collapses repeat notifications from the same channel into one. */
  tag?: string;
  onClick?: () => void;
}

/**
 * Show a notification, ignoring the request when permission is missing.
 * Returns whether one was actually raised.
 */
export function showDesktopNotification(n: DesktopNotification): boolean {
  if (notificationPermission() !== "granted") return false;
  try {
    const notification = new Notification(n.title, {
      body: n.body,
      icon: n.icon,
      tag: n.tag,
    });
    if (n.onClick) {
      notification.onclick = () => {
        window.focus();
        n.onClick!();
        notification.close();
      };
    }
    return true;
  } catch {
    // Some browsers throw when constructing outside a service worker.
    return false;
  }
}

/** Trim a message body to something that reads well in a notification. */
export function notificationBody(body: string, max = 140): string {
  const collapsed = body.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}
