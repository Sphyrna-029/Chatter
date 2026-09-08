import { useMemo, useState } from "react";
import { useAppState } from "@/lib/store";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  useThemeSettings,
  decodeThemeShare,
  THEME_PARAM,
  type ThemeDefinition,
} from "@/lib/theme";

/** Codes already offered and answered, so nobody is asked twice. Keyed by the
 *  code rather than by the room: two rooms suggesting the same theme is one
 *  question, and a room changing its suggestion is a new one. */
const SEEN_KEY = "chatter_theme_offers_seen";

function loadSeen(): string[] {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((c) => typeof c === "string") : [];
  } catch {
    return [];
  }
}

function rememberSeen(code: string, previous: string[]): string[] {
  // Bounded: this only exists to stop a repeat question, and an unbounded list
  // in localStorage would outlive every room that put entries in it.
  const next = [...previous.filter((c) => c !== code), code].slice(-100);
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(next));
  } catch {
    // Worst case the offer is made again next time.
  }
  return next;
}

/**
 * Offers a theme somebody else picked — from a share link, or from the room
 * being viewed.
 *
 * Shown, never applied. Following a link or opening a room should not silently
 * repaint the app, so both paths end at the same question and the answer is
 * remembered. A room's suggestion is exactly that: declining it leaves nothing
 * changed, and the room cannot ask again unless it suggests something else.
 *
 * The URL path works signed out as well as in. Being handed a theme at the
 * login screen is a perfectly ordinary way to arrive.
 */
/**
 * Read at import rather than in an effect.
 *
 * The URL the app was opened with is a fact from before React existed, and
 * taking the parameter off is a one-time act — running it from an effect means
 * running it twice under StrictMode, where the second pass finds the parameter
 * already gone.
 */
const arrivingShare: { theme: ThemeDefinition | null; error: string | null } =
  (() => {
    if (typeof window === "undefined") return { theme: null, error: null };
    const params = new URLSearchParams(window.location.search);
    const code = params.get(THEME_PARAM);
    if (!code) return { theme: null, error: null };

    params.delete(THEME_PARAM);
    const query = params.toString();
    window.history.replaceState(
      null,
      "",
      window.location.pathname +
        (query ? `?${query}` : "") +
        window.location.hash,
    );

    try {
      return { theme: decodeThemeShare(code), error: null };
    } catch (e) {
      return {
        theme: null,
        error: e instanceof Error ? e.message : "That is not a theme",
      };
    }
  })();

export function ThemeInvite() {
  const { addCustomTheme, setTheme } = useThemeSettings();
  const { currentRoomId, roomInfoMap } = useAppState();

  const [linkOffer, setLinkOffer] = useState<ThemeDefinition | null>(
    arrivingShare.theme,
  );
  const [error, setError] = useState<string | null>(arrivingShare.error);
  const [seen, setSeen] = useState<string[]>(loadSeen);

  const roomCode = currentRoomId
    ? roomInfoMap[currentRoomId]?.suggested_theme || ""
    : "";

  // Derived rather than pushed into state from an effect: the offer is a
  // function of which room is open and what has already been answered.
  const roomOffer = useMemo(() => {
    if (!roomCode || seen.includes(roomCode)) return null;
    try {
      return decodeThemeShare(roomCode);
    } catch {
      // A room holding a code this client cannot read is not the member's
      // problem to see.
      return null;
    }
  }, [roomCode, seen]);

  const offered = linkOffer ?? roomOffer;
  const fromRoom = !linkOffer && roomOffer !== null;

  const close = () => {
    if (linkOffer) setLinkOffer(null);
    else if (roomCode) setSeen((prev) => rememberSeen(roomCode, prev));
    setError(null);
  };

  if (!offered && !error) return null;

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {offered ? "Add this theme?" : "That link has no theme in it"}
          </DialogTitle>
        </DialogHeader>

        {offered ? (
          <div className="space-y-4">
            <div
              className="rounded-lg border border-muted-foreground/20 p-3"
              style={{ backgroundColor: offered.colors!.background }}
            >
              <span
                className="block text-sm font-medium mb-2"
                style={{ color: offered.colors!.primary }}
              >
                {offered.name}
              </span>
              <div className="flex gap-1.5">
                {Object.values(offered.colors!).map((color, i) => (
                  <div
                    key={i}
                    className="h-4 w-4 rounded-full border border-white/10"
                    style={{ backgroundColor: color }}
                  />
                ))}
              </div>
            </div>
            <p className="ui-hint">
              {fromRoom
                ? `${roomInfoMap[currentRoomId!]?.name || "This room"} suggests this theme. Declining changes nothing.`
                : "Someone shared this with you. Adding it keeps it in your themes; nothing changes until you do."}
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                className="flex-1"
                onClick={() => {
                  const added = addCustomTheme(
                    offered.name,
                    offered.colors!,
                    offered.mode,
                    offered.advanced,
                  );
                  setTheme(added.id);
                  close();
                }}
              >
                Add and apply
              </Button>
              <Button variant="outline" size="sm" onClick={close}>
                No thanks
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">{error}</p>
            <Button size="sm" className="w-full" onClick={close}>
              Close
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
