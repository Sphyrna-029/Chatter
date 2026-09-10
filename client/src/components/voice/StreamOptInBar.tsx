import { useAppContext } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Monitor, Camera } from "lucide-react";
import { displayUserId } from "@/lib/utils";

/**
 * A live stream in the call is an offer, not an interruption.
 *
 * Nobody's video takes over anybody else's screen: the viewer opens when the
 * user asks for it, and this bar is where the asking happens. Opening it is
 * also what subscribes to the video, so a call full of people who are not
 * watching costs the sharer nothing.
 *
 * It only stands in for the closed viewer — once the viewer is open, the
 * viewer's own header carries the controls.
 */
export function StreamOptInBar() {
  const { state, dispatch } = useAppContext();

  if (!state.inVoiceChannel || state.screenViewerOpen) return null;

  const screens = state.activeScreenSharers;
  const cameras = state.activeWebcamStreamers;
  // Someone sharing a screen and a camera at once is one person, not two.
  const streamers = Array.from(new Set([...screens, ...cameras]));
  if (streamers.length === 0) return null;

  const name = (userId: string) =>
    userId === state.userId
      ? "You"
      : state.userPresence[userId]?.displayName || displayUserId(userId);

  const label =
    streamers.length === 1
      ? `${name(streamers[0])} ${streamers[0] === state.userId ? "are" : "is"} streaming`
      : streamers.length === 2
        ? `${name(streamers[0])} and ${name(streamers[1])} are streaming`
        : `${streamers.length} people are streaming`;

  // Open on a screen when there is one; with only cameras live the viewer
  // picks the first of those itself.
  const openViewer = () =>
    dispatch({
      type: "SET_SCREEN_VIEWER",
      payload: { open: true, sharer: screens[0] ?? null },
    });

  return (
    <div className="flex items-center gap-2 border-b bg-info/10 px-4 py-1.5 shrink-0">
      <span className="relative flex h-2 w-2 shrink-0">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-destructive opacity-75" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-destructive" />
      </span>
      {screens.length > 0 ? (
        <Monitor className="h-3.5 w-3.5 shrink-0 text-info" />
      ) : (
        <Camera className="h-3.5 w-3.5 shrink-0 text-blue-400" />
      )}
      <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
        {label}
      </span>
      {/* With more than one to choose from, a per-person way in beats picking
          for them — the viewer's thumbnail strip only exists once it is open.
          A phone has no room for the row, and once open its thumbnail strip is
          the better switcher anyway, so there it is just the one button. */}
      {streamers.length > 1 && (
        <div className="hidden shrink-0 items-center gap-1 md:flex">
          {streamers.map((userId) => (
            <button
              key={userId}
              onClick={() =>
                dispatch({
                  type: "SET_SCREEN_VIEWER",
                  payload: screens.includes(userId)
                    ? { open: true, sharer: userId }
                    : { open: true, webcamStreamer: userId },
                })
              }
              className="rounded px-1.5 py-0.5 text-xs text-info transition-colors hover:bg-info/20 cursor-pointer"
              title={`View ${name(userId)}'s stream`}
            >
              {name(userId)}
            </button>
          ))}
        </div>
      )}
      <Button size="sm" className="h-11 shrink-0 gap-1.5 md:h-7" onClick={openViewer}>
        <Monitor className="h-3.5 w-3.5" />
        View stream
      </Button>
    </div>
  );
}
