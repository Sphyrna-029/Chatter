import { useState, useEffect } from "react";
import { useAppContext } from "@/lib/store";
import { apiGetAuthenticatedBlobUrl } from "@/lib/api";
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
  if (PREVIEW_IMAGE_EXT.test(base)) {
    const suffix = query ? `?${query}` : "";
    return `${base}.preview.webp${suffix}`;
  }
  return url;
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
  const [blobSrc, setBlobSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!needsAuth) return;
    let objectUrl: string | null = null;
    setBlobSrc(null);
    setFailed(false);
    apiGetAuthenticatedBlobUrl(effectiveSrc)
      .then((url) => { objectUrl = url; setBlobSrc(url); })
      .catch(() => setFailed(true));
    return () => { if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [effectiveSrc, needsAuth]);

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
  const [blobSrc, setBlobSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!needsAuth || !effectiveSrc) return;
    let objectUrl: string | null = null;
    setBlobSrc(null);
    setFailed(false);
    apiGetAuthenticatedBlobUrl(effectiveSrc)
      .then((url) => { objectUrl = url; setBlobSrc(url); })
      .catch(() => setFailed(true));
    return () => { if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [effectiveSrc, needsAuth]);

  if (!src || failed) return null;
  if (needsAuth && !blobSrc) return null;

  return <AvatarImage src={needsAuth ? blobSrc! : effectiveSrc || src} className={className} />;
}
