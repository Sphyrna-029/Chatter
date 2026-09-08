import { useState } from "react";
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

/**
 * Offers a theme that arrived on the URL.
 *
 * A share link is someone else's suggestion, so it is shown and not applied:
 * opening a link should never silently repaint the app. The parameter is taken
 * off the URL as soon as it is read, so a refresh — or a bookmark made
 * afterwards — does not ask again.
 *
 * This works signed out as well as in. A theme is local until it syncs, and
 * being handed one at the login screen is a perfectly ordinary way to arrive.
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
  const [offered, setOffered] = useState<ThemeDefinition | null>(
    arrivingShare.theme,
  );
  const [error, setError] = useState<string | null>(arrivingShare.error);

  const close = () => {
    setOffered(null);
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
              Someone shared this with you. Adding it keeps it in your themes;
              nothing changes until you do.
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
