/** A folder name as the server writes it: `external/<32 hex>/<file>`. */
const UPLOAD_FOLDER = /^[0-9a-f]{32}$/i;

/**
 * The upload folders a message body refers to.
 *
 * The mirror of `attachment_folders` in `src/backend/routes/media.rs`, down to
 * the punctuation trimming, because the two have to agree: this decides
 * whether the client offers to delete the files, and that decides whether
 * anything is actually deleted. Offering on a body the server will find
 * nothing in is a promise the delete cannot keep.
 */
export function attachmentFolders(body: string): string[] {
  const folders = new Set<string>();
  for (const token of body.split(/\s+/)) {
    // Punctuation from the prose a link was pasted into, on both sides.
    const trimmed = token.replace(/^[([<"']+/, "").replace(/[.,)\]>"'!?]+$/, "");
    const rest = trimmed.split("/external/")[1];
    if (rest === undefined) continue;
    const folder = rest.split("/")[0];
    // Anything under `/external/` that is not a file inside a random 32-hex
    // folder is a path this server did not write, and nothing here should act
    // on one.
    const namedAFile = rest.length > folder.length + 1;
    if (namedAFile && UPLOAD_FOLDER.test(folder)) folders.add(folder);
  }
  return [...folders].sort();
}
