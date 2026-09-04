import { describe, it, expect } from "vitest";
import {
  DEFAULT_NOTIFICATION_LEVEL,
  notificationBody,
  resolveNotificationLevel,
  settingsKey,
  shouldNotify,
  type NotificationSettings,
} from "@/lib/notifications";

describe("resolveNotificationLevel", () => {
  it("falls back to the default when nothing is set", () => {
    expect(resolveNotificationLevel({}, "!r", "#c")).toBe(DEFAULT_NOTIFICATION_LEVEL);
  });

  it("uses the room setting when the channel has no override", () => {
    const settings: NotificationSettings = { [settingsKey("!r", "")]: "mentions" };
    expect(resolveNotificationLevel(settings, "!r", "#c")).toBe("mentions");
  });

  it("prefers a channel override over the room setting", () => {
    const settings: NotificationSettings = {
      [settingsKey("!r", "")]: "none",
      [settingsKey("!r", "#loud")]: "all",
    };
    expect(resolveNotificationLevel(settings, "!r", "#loud")).toBe("all");
    expect(resolveNotificationLevel(settings, "!r", "#other")).toBe("none");
  });

  it("does not let one room's setting leak into another", () => {
    const settings: NotificationSettings = { [settingsKey("!a", "")]: "none" };
    expect(resolveNotificationLevel(settings, "!b", "#c")).toBe(DEFAULT_NOTIFICATION_LEVEL);
  });
});

describe("shouldNotify", () => {
  const base = { isMention: false, isDm: false, isViewing: false, presence: "online" };

  it("notifies for any message at level all", () => {
    expect(shouldNotify({ ...base, level: "all" })).toBe(true);
  });

  it("at level mentions, only mentions and DMs get through", () => {
    expect(shouldNotify({ ...base, level: "mentions" })).toBe(false);
    expect(shouldNotify({ ...base, level: "mentions", isMention: true })).toBe(true);
    expect(shouldNotify({ ...base, level: "mentions", isDm: true })).toBe(true);
  });

  it("level none suppresses even a direct mention", () => {
    expect(shouldNotify({ ...base, level: "none", isMention: true, isDm: true })).toBe(false);
  });

  it("stays quiet while the user is looking at that channel", () => {
    expect(shouldNotify({ ...base, level: "all", isViewing: true })).toBe(false);
    expect(shouldNotify({ ...base, level: "all", isViewing: true, isMention: true })).toBe(false);
  });

  it("respects do-not-disturb above everything else", () => {
    expect(shouldNotify({ ...base, level: "all", presence: "dnd", isMention: true })).toBe(false);
  });
});

describe("notificationBody", () => {
  it("collapses whitespace", () => {
    expect(notificationBody("hello   \n  world")).toBe("hello world");
  });

  it("truncates with an ellipsis", () => {
    expect(notificationBody("x".repeat(200), 10)).toBe(`${"x".repeat(9)}…`);
  });

  it("leaves a short body untouched", () => {
    expect(notificationBody("short")).toBe("short");
  });
});
