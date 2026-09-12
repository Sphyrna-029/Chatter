import { useCallback, useEffect, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import * as VisuallyHidden from "@radix-ui/react-visually-hidden";
import { AuthImage } from "@/components/AuthImage";
import { cn } from "@/lib/utils";
import { ChevronLeft, ChevronRight } from "lucide-react";

/**
 * The images on a forum post or comment, laid out by how many there are.
 *
 * One image is the post's picture and gets the width to be looked at; several
 * are a set, and read better as an even grid than as a column of full-bleed
 * images the reader has to scroll past to reach the comments. Either way a tap
 * opens the full-resolution original, where the set can be paged through.
 */
export function ForumImageGallery({
  images,
  className,
  compact,
}: {
  images: string[];
  className?: string;
  /** Sized for a comment rather than the body of a post. */
  compact?: boolean;
}) {
  const [lightboxAt, setLightboxAt] = useState<number | null>(null);

  const step = useCallback(
    (delta: number) =>
      setLightboxAt((at) =>
        at === null ? at : (at + delta + images.length) % images.length,
      ),
    [images.length],
  );

  // Arrow keys page the set; the dialog already closes on Escape.
  useEffect(() => {
    if (lightboxAt === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") step(1);
      else if (e.key === "ArrowLeft") step(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightboxAt, step]);

  if (images.length === 0) return null;

  const single = images.length === 1;

  return (
    <div className={className}>
      {single ? (
        <AuthImage
          src={images[0]}
          alt=""
          className={cn(
            "w-full object-contain rounded-lg bg-muted cursor-pointer",
            compact ? "max-w-xs max-h-48" : "max-h-96",
          )}
          onClick={() => setLightboxAt(0)}
        />
      ) : (
        <div
          className={cn(
            "grid gap-1.5",
            // Two side by side; three or more in threes, so a row is never one
            // lonely image wide on a desktop and never cramped on a phone.
            images.length === 2 ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-3",
            compact && "max-w-xs",
          )}
        >
          {images.map((url, i) => (
            <AuthImage
              key={`${url}-${i}`}
              src={url}
              alt=""
              className={cn(
                "w-full object-cover rounded-md bg-muted cursor-pointer",
                compact ? "aspect-square" : images.length === 2 ? "aspect-4/3" : "aspect-square",
              )}
              onClick={() => setLightboxAt(i)}
            />
          ))}
        </div>
      )}

      <Dialog
        open={lightboxAt !== null}
        onOpenChange={(open) => { if (!open) setLightboxAt(null); }}
      >
        <DialogContent className="max-w-[90vw] max-h-[90vh] p-0 border-none bg-transparent shadow-none flex items-center justify-center [&>button]:text-white [&>button]:bg-black/50 [&>button]:rounded-full [&>button]:p-1">
          <VisuallyHidden.Root><DialogTitle>Image preview</DialogTitle></VisuallyHidden.Root>
          {lightboxAt !== null && (
            <>
              <AuthImage
                src={images[lightboxAt]}
                alt=""
                preview={false}
                className="max-w-[90vw] max-h-[90vh] object-contain rounded-md"
              />
              {images.length > 1 && (
                <>
                  <button
                    onClick={() => step(-1)}
                    className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-2 text-white"
                    aria-label="Previous image"
                  >
                    <ChevronLeft className="h-5 w-5" />
                  </button>
                  <button
                    onClick={() => step(1)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-2 text-white"
                    aria-label="Next image"
                  >
                    <ChevronRight className="h-5 w-5" />
                  </button>
                  <span className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-black/50 px-2 py-0.5 text-xs tabular-nums text-white">
                    {lightboxAt + 1} / {images.length}
                  </span>
                </>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
