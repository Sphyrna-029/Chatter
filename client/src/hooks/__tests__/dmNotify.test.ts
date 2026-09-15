/**
 * @vitest-environment jsdom
 *
 * Covers the wiring around the notification policy rather than the policy
 * itself (see notifications.test.ts): what the handler decides a DM *is*, and
 * whether it gets as far as raising one.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { initialState } from "@/lib/store/types";
import type { AppState } from "@/lib/store/types";

const shown = vi.fn();
vi.mock("@/lib/notifications", async (orig) => {
  const actual = await orig<typeof import("@/lib/notifications")>();
  return { ...actual, showDesktopNotification: (n: unknown) => { shown(n); return true; } };
});
vi.mock("@/lib/sounds", () => ({
  arrivalSound: () => "", deferArrivalSound: () => {}, playSound: () => {},
  playSoundUrl: () => {}, prewarmSounds: () => {},
}));
vi.mock("../api", () => ({ apiSync: vi.fn(), apiGetPresence: vi.fn() }));
vi.mock("sonner", () => ({ toast: Object.assign(() => {}, { error: () => {}, success: () => {} }) }));

import { createWsMessageHandler } from "@/lib/store/wsHandler";

function harness(state: Partial<AppState>) {
  const full = { ...initialState, userId: "@me:x", ...state } as AppState;
  const ref = { current: full };
  const handler = createWsMessageHandler(
    vi.fn(), ref, { current: {} }, { current: async () => {} },
  );
  return handler;
}

const dmRoomInfo: AppState["roomInfoMap"] = {
  "!dm:x": { room_id: "!dm:x", name: "DM with Rio", topic: "", is_direct: true },
};

const dmMessage = {
  type: "m.room.message",
  is_dm: true,
  room_id: "!dm:x",
  sender: "@rio:x",
  content: { body: "hey are you around?", msgtype: "m.text" },
  origin_server_ts: Date.now(),
};

describe("DM notifications", () => {
  beforeEach(() => { shown.mockClear(); vi.spyOn(document, "hasFocus").mockReturnValue(false); });

  it("notifies for a DM in a room the client knows about", () => {
    const h = harness({
      roomInfoMap: dmRoomInfo,
    });
    h(dmMessage);
    expect(shown).toHaveBeenCalledTimes(1);
  });

  it("notifies for a DM from someone whose room has not been loaded yet", () => {
    const h = harness({ roomInfoMap: {} });
    h(dmMessage);
    expect(shown).toHaveBeenCalledTimes(1);
  });

  it("notifies for a DM when the room level is mentions-only", () => {
    const h = harness({
      roomInfoMap: dmRoomInfo,
      notificationSettings: { "!dm:x|": "mentions" as const },
    });
    h(dmMessage);
    expect(shown).toHaveBeenCalledTimes(1);
  });

  it("notifies for a mentions-only DM the client has not loaded", () => {
    // The first message of a new conversation can arrive before the room that
    // explains it. Read as an ordinary room, "mentions only" silently drops it
    // — which is the one case where being told matters most.
    const h = harness({
      roomInfoMap: {},
      notificationSettings: { "!dm:x|": "mentions" as const },
    });
    h(dmMessage);
    expect(shown).toHaveBeenCalledTimes(1);
  });

  it("falls back to the room list when the server does not stamp is_dm", () => {
    // A server that predates the flag still has to work.
    const withoutFlag = { ...dmMessage, is_dm: undefined };
    const h = harness({
      roomInfoMap: dmRoomInfo,
      notificationSettings: { "!dm:x|": "mentions" as const },
    });
    h(withoutFlag);
    expect(shown).toHaveBeenCalledTimes(1);
  });

  it("does not mistake an ordinary room for a DM", () => {
    // The mentions gate has to still bite where it should.
    const roomMessage = { ...dmMessage, is_dm: undefined };
    const h = harness({
      roomInfoMap: {
        "!dm:x": { room_id: "!dm:x", name: "General", topic: "" },
      },
      notificationSettings: { "!dm:x|": "mentions" as const },
    });
    h(roomMessage);
    expect(shown).toHaveBeenCalledTimes(0);
  });

  it("notifies while the user is reading a different room", () => {
    const h = harness({
      currentRoomId: "!other:x",
      roomInfoMap: dmRoomInfo,
    });
    h(dmMessage);
    expect(shown).toHaveBeenCalledTimes(1);
  });

  it("stays quiet when the DM is already open and focused", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const h = harness({
      currentRoomId: "!dm:x",
      roomInfoMap: dmRoomInfo,
    });
    h(dmMessage);
    expect(shown).toHaveBeenCalledTimes(0);
  });

  it("notifies when the DM is open but the tab is in the background", () => {
    const h = harness({
      currentRoomId: "!dm:x",
      roomInfoMap: dmRoomInfo,
    });
    h(dmMessage);
    expect(shown).toHaveBeenCalledTimes(1);
  });

  it("titles a DM with the sender, not the room", () => {
    const h = harness({
      roomInfoMap: dmRoomInfo,
      userPresence: { "@rio:x": { status: "online", displayName: "Rio" } },
    });
    h(dmMessage);
    expect(shown.mock.calls[0][0]).toMatchObject({ title: "Rio" });
  });
});
