/**
 * What a URL points at, decided by its extension.
 *
 * These lived inside MessageItem, where the chat timeline was the only thing
 * that needed to tell a picture from a video. The forum needs the same answer,
 * and two copies of the list is how the two surfaces end up disagreeing about
 * whether a .mov is a video.
 */
export const IMAGE_EXTENSIONS = /\.(jpg|jpeg|png|gif|webp|bmp|svg)(\?.*)?$/i;
export const VIDEO_EXTENSIONS = /\.(mp4|webm|ogg|mov|mkv)(\?.*)?$/i;
export const AUDIO_EXTENSIONS = /\.(mp3|wav|flac|aac|m4a)(\?.*)?$/i;

export function isImageUrl(url: string): boolean {
  return IMAGE_EXTENSIONS.test(url);
}

export function isVideoUrl(url: string): boolean {
  return VIDEO_EXTENSIONS.test(url);
}

export function isAudioUrl(url: string): boolean {
  return AUDIO_EXTENSIONS.test(url);
}

/**
 * How the forum lays out a file it has been given: in the gallery as a picture
 * or a clip, or as a download.
 *
 * Judged on the type *and* the name. A browser reports `image/tiff` and
 * `image/heic` as images it cannot draw, and a picture slot holding one is a
 * broken square — so only what the chat would also draw inline is media, and
 * everything else is a file, which any browser can at least download.
 */
export function forumAttachmentKind(file: File): "image" | "video" | "file" {
  if (file.type.startsWith("image/") && isImageUrl(file.name)) return "image";
  if (file.type.startsWith("video/") && isVideoUrl(file.name)) return "video";
  return "file";
}

/** Uploaded forum attachments sorted into the three lists a post carries,
 *  each in the order the files were added. */
export function sortForumAttachments(uploaded: { file: File; url: string }[]): {
  imageUrls: string[];
  videoUrls: string[];
  fileUrls: string[];
} {
  const sorted = { imageUrls: [] as string[], videoUrls: [] as string[], fileUrls: [] as string[] };
  for (const { file, url } of uploaded) {
    const kind = forumAttachmentKind(file);
    (kind === "image" ? sorted.imageUrls : kind === "video" ? sorted.videoUrls : sorted.fileUrls).push(url);
  }
  return sorted;
}
