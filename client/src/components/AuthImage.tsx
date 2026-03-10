import { useState, useEffect } from "react";
import { useAppContext } from "@/lib/store";
import { apiGetAuthenticatedBlobUrl } from "@/lib/api";
import { AvatarImage } from "@/components/ui/avatar";

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
}: {
  src: string;
  alt: string;
  className?: string;
  onClick?: React.MouseEventHandler<HTMLImageElement>;
  onError?: React.ReactEventHandler<HTMLImageElement>;
  loading?: "lazy" | "eager";
  style?: React.CSSProperties;
}) {
  const { state } = useAppContext();
  const isUpload = src.includes("/external/");
  const needsAuth = isUpload && state.requireAuthForUploads;
  const [blobSrc, setBlobSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!needsAuth) return;
    let objectUrl: string | null = null;
    setBlobSrc(null);
    setFailed(false);
    apiGetAuthenticatedBlobUrl(src)
      .then((url) => { objectUrl = url; setBlobSrc(url); })
      .catch(() => setFailed(true));
    return () => { if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [src, needsAuth]);

  if (failed) return null;
  if (needsAuth && !blobSrc) return null;

  return (
    <img
      src={needsAuth ? blobSrc! : src}
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
export function AuthAvatarImage({ src, className }: { src?: string; className?: string }) {
  const { state } = useAppContext();
  const isUpload = !!src && src.includes("/external/");
  const needsAuth = isUpload && state.requireAuthForUploads;
  const [blobSrc, setBlobSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!needsAuth || !src) return;
    let objectUrl: string | null = null;
    setBlobSrc(null);
    setFailed(false);
    apiGetAuthenticatedBlobUrl(src)
      .then((url) => { objectUrl = url; setBlobSrc(url); })
      .catch(() => setFailed(true));
    return () => { if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [src, needsAuth]);

  if (!src || failed) return null;
  if (needsAuth && !blobSrc) return null;

  return <AvatarImage src={needsAuth ? blobSrc! : src} className={className} />;
}
