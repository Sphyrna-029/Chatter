import { useState, useEffect } from "react";
import { useAppContext } from "@/lib/store";
import { apiGetAuthenticatedBlobUrl } from "@/lib/api";
import {
  peekMediaBlob,
  retainMediaBlob,
  loadMediaBlob,
  releaseMediaBlob,
} from "@/lib/mediaBlobs";
import { AvatarImage } from "@/components/ui/avatar";

const PREVIEW_IMAGE_EXT = /\.(jpe?g|png|webp|bmp|tiff)(\?.*)?$/i;

/**
 * Return a downscaled WebP preview URL for a still image under /external/ so
 * it loads quickly. GIFs/SVGs are left untouched (animation/interactivity).
 * Lightbox/zoom should keep using the original URL for full resolution.
 */
export function toImagePreviewUrl(url: string): string {
  if (!url || !url.includes("/external/")) return url;
  const [base, query] = url.split("?");
  if (base.endsWith(".preview.webp")) return url; // already a preview
  // A video's thumbnail is already the downscaled version of something, and
  // asking for a preview of it costs rather than saves: the server scales a
  // 640px sidecar up to 1024 to answer, and — because the thumbnail is
  // generated on demand, keyed to a request for the thumbnail itself — a video
  // nobody has opened yet has nothing to make the preview from, so the request
  // 404s and the message shows an empty black box instead of a first frame.
  if (base.endsWith(".thumb.jpg")) return url;
  if (PREVIEW_IMAGE_EXT.test(base)) {
    const suffix = query ? `?${query}` : "";
    return `${base}.preview.webp${suffix}`;
  }
  return url;
}

/**
 * Resolve a `src` to something an `<img>` can use, fetching it with the
 * session's credentials when the server demands them.
 *
 * `null` while there is nothing to show yet, which happens only on a genuine
 * first load: a URL already in the blob cache is answered during this render,
 * so remounting an avatar — scrolling a member list, reopening a dialog — no
 * longer blanks it while a fetch it does not need goes out.
 *
 * Shared by both components below, which had the same effect written twice.
 */
function useResolvedSrc(src: string | undefined, needsAuth: boolean) {
  const key = needsAuth && src ? src : null;

  // Answered during render, so a URL the cache already holds needs no state
  // and no effect to display — that is the whole point, and it is what stops
  // a remounting avatar from blanking on its way back.
  const cached = key ? peekMediaBlob(key) : null;

  // Only a miss has anything to remember, and the key is stored beside the
  // result: a stale answer is then ignored by the render below rather than
  // cleared by the effect, which is what keeps this a fetch lifecycle instead
  // of a state-sync.
  const [fetched, setFetched] = useState<{
    key: string;
    url: string | null;
    failed: boolean;
  } | null>(null);

  useEffect(() => {
    if (!key) return;

    // Whether this effect is holding a reference, so the cleanup knows if it
    // owes one back. The fetch can land either side of unmount.
    let held = false;
    let live = true;

    if (retainMediaBlob(key)) {
      held = true;
    } else {
      loadMediaBlob(key, apiGetAuthenticatedBlobUrl).then(
        (objectUrl) => {
          if (!live) {
            releaseMediaBlob(key);
            return;
          }
          held = true;
          setFetched({ key, url: objectUrl, failed: false });
        },
        () => {
          if (live) setFetched({ key, url: null, failed: true });
        },
      );
    }

    return () => {
      live = false;
      if (held) releaseMediaBlob(key);
    };
  }, [key]);

  if (!key) return { resolved: null, failed: false };
  if (cached) return { resolved: cached, failed: false };
  if (fetched?.key === key) return { resolved: fetched.url, failed: fetched.failed };
  return { resolved: null, failed: false };
}

/**
 * Drop-in replacement for <img> that fetches /external/ uploads with auth headers
 * when the server setting requireAuthForUploads is enabled.
 */
export function AuthImage({
  src,
  alt,
  className,
  onClick,
  onError,
  loading,
  style,
  preview = true,
}: {
  src: string;
  alt: string;
  className?: string;
  onClick?: React.MouseEventHandler<HTMLImageElement>;
  onError?: React.ReactEventHandler<HTMLImageElement>;
  loading?: "lazy" | "eager";
  style?: React.CSSProperties;
  /** When true (default), still images under /external/ use the lightweight
   * `.preview.webp` variant. Set false to load the full-resolution original. */
  preview?: boolean;
}) {
  const { state } = useAppContext();
  const effectiveSrc = preview ? toImagePreviewUrl(src) : src;
  const isUpload = effectiveSrc.includes("/external/");
  const needsAuth = isUpload && state.requireAuthForUploads;
  const { resolved: blobSrc, failed } = useResolvedSrc(effectiveSrc, needsAuth);

  if (failed) return null;
  if (needsAuth && !blobSrc) return null;

  return (
    <img
      src={needsAuth ? blobSrc! : effectiveSrc}
      alt={alt}
      className={className}
      onClick={onClick}
      onError={onError}
      loading={loading}
      style={style}
    />
  );
}

/**
 * Drop-in replacement for <AvatarImage> that fetches /external/ uploads with auth headers
 * when the server setting requireAuthForUploads is enabled.
 * Accepts an optional src so it can replace the `{url && <AvatarImage src={url} />}` pattern.
 */
export function AuthAvatarImage({ src, className, preview = true }: { src?: string; className?: string; preview?: boolean }) {
  const { state } = useAppContext();
  const effectiveSrc = preview && src ? toImagePreviewUrl(src) : src;
  const isUpload = !!effectiveSrc && effectiveSrc.includes("/external/");
  const needsAuth = isUpload && state.requireAuthForUploads;
  const { resolved: blobSrc, failed } = useResolvedSrc(effectiveSrc, needsAuth);

  if (!src || failed) return null;
  if (needsAuth && !blobSrc) return null;

  return <AvatarImage src={needsAuth ? blobSrc! : effectiveSrc || src} className={className} />;
}
