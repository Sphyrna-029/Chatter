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

/** The `accept` value for a picker that takes either. */
export const IMAGE_AND_VIDEO_ACCEPT = "image/*,video/*";

/** True for a File the forum will take as a picture or a clip. */
export function isImageOrVideoFile(file: File): boolean {
  return file.type.startsWith("image/") || file.type.startsWith("video/");
}
