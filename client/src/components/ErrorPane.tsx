import { RefreshCw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isChunkLoadError } from "@/lib/lazyRetry";

/**
 * What a caught error looks like.
 *
 * Two different situations, and the difference decides what to offer. A view
 * that would not load is nearly always a build that moved underneath an open
 * tab, and only a reload can pick up the new filenames — so that is the button.
 * A view that threw is a bug, where reloading reproduces it and stepping back
 * into the view is the thing worth trying.
 */
export function ErrorPane({ error, reset }: { error: Error; reset: () => void }) {
  const stale = isChunkLoadError(error);
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center">
      {stale ? (
        <RefreshCw className="h-6 w-6 text-muted-foreground" />
      ) : (
        <TriangleAlert className="h-6 w-6 text-destructive" />
      )}
      <p className="text-sm font-medium">
        {stale ? "Chatter has been updated" : "This view ran into a problem"}
      </p>
      <p className="max-w-xs text-xs text-muted-foreground">
        {stale
          ? "This tab is running an older build and could not load the rest of it. Reloading picks up the new one."
          : "The rest of the app is still running — you can go back to it, or try this view again."}
      </p>
      {stale ? (
        <Button size="sm" onClick={() => window.location.reload()}>
          Reload
        </Button>
      ) : (
        <Button size="sm" variant="outline" onClick={reset}>
          Try again
        </Button>
      )}
      {!stale && (
        <p className="max-w-md truncate text-3xs text-muted-foreground/70">
          {error.message}
        </p>
      )}
    </div>
  );
}
