import { useSyncExternalStore } from "react";
import {
  apiCancelUpload,
  apiSendMessage,
  apiSendThreadMessage,
  apiUploadFile,
} from "@/lib/api";
import { isPreviewable } from "@/hooks/usePendingFiles";
import { runPool, UPLOAD_CONCURRENCY } from "@/lib/concurrency";
import type { UploadStatus } from "@/hooks/useUploadQueue";

/**
 * Sends that are still going out, held outside React so that leaving the room
 * they were composed in does not touch them.
 *
 * A send with attachments used to live entirely inside the composer that
 * started it: the progress was component state, the staged row was cleared on
 * a room switch, and the message was posted through a callback that read the
 * *current* room at the moment it resolved. So changing channel during a large
 * upload took the progress off the screen and then delivered the message
 * wherever the person had gone — the one thing a send must never do.
 *
 * Here the destination is decided when Send is pressed and carried with the
 * work, and the work belongs to the module rather than to whichever composer
 * is mounted. A batch outlives every component; the UI only subscribes to it.
 */

/** Where a batch is going. Captured at send time and never re-read. */
export type OutgoingTarget =
  | {
      kind: "channel";
      roomId: string;
      channelId: string;
      replyTo?: string;
      spoiler?: boolean;
    }
  | { kind: "thread"; roomId: string; threadEventId: string; replyTo?: string };

export interface OutgoingFile {
  id: string;
  file: File;
  /** Object URL for image and video previews; null for everything else. */
  previewUrl: string | null;
  status: UploadStatus;
  /** 0-100. Meaningless once the status is "processing" or later. */
  pct: number;
}

export interface OutgoingBatch {
  id: string;
  target: OutgoingTarget;
  /** What to call the destination when it is not the one on screen. */
  label: string;
  /** Message text, already resolved. Cleared once it has actually been sent,
   *  so a retry of the files behind it does not post it twice. */
  body: string;
  files: OutgoingFile[];
  status: "running" | "failed";
  error?: string;
}

let batches: OutgoingBatch[] = [];
const listeners = new Set<() => void>();
let nextId = 0;

function emit() {
  // A new array each time, because `useSyncExternalStore` compares snapshots
  // by identity and must not see an in-place edit as no change.
  batches = [...batches];
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

function snapshot() {
  return batches;
}

/** Every send still on its way, wherever it is going. */
export function useOutgoingUploads(): OutgoingBatch[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** The same, for anything outside React that wants to look. */
export function outgoingUploads(): OutgoingBatch[] {
  return batches;
}

function patchBatch(id: string, change: (batch: OutgoingBatch) => OutgoingBatch) {
  batches = batches.map((batch) => (batch.id === id ? change(batch) : batch));
  emit();
}

function patchFile(batchId: string, fileId: string, status: UploadStatus, pct: number) {
  patchBatch(batchId, (batch) => ({
    ...batch,
    files: batch.files.map((entry) =>
      entry.id === fileId ? { ...entry, status, pct } : entry,
    ),
  }));
}

function dropBatch(id: string) {
  const going = batches.find((batch) => batch.id === id);
  going?.files.forEach((entry) => entry.previewUrl && URL.revokeObjectURL(entry.previewUrl));
  batches = batches.filter((batch) => batch.id !== id);
  emit();
}

/** Whether two targets are the same place, so a view can claim its own batches. */
export function isSameTarget(a: OutgoingTarget, b: OutgoingTarget): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "thread" && b.kind === "thread") {
    return a.roomId === b.roomId && a.threadEventId === b.threadEventId;
  }
  if (a.kind === "channel" && b.kind === "channel") {
    return a.roomId === b.roomId && a.channelId === b.channelId;
  }
  return false;
}

/**
 * Start a send that carries files, and hand it back the moment it is queued.
 *
 * The caller has already cleared its composer: the batch owns the text and the
 * files from here, which is what makes it safe to walk away from.
 */
export function enqueueOutgoing(input: {
  target: OutgoingTarget;
  label: string;
  body: string;
  files: File[];
}): string {
  const id = `outgoing-${nextId++}`;
  const batch: OutgoingBatch = {
    id,
    target: input.target,
    label: input.label,
    body: input.body,
    files: input.files.map((file, index) => ({
      // By position, not by the file: the same file can legitimately be
      // attached twice, and two tiles sharing an id would move together.
      id: `${id}-${index}`,
      file,
      // Created here rather than inside the runner, so the tiles have their
      // pictures from the first render.
      previewUrl: isPreviewable(file) ? URL.createObjectURL(file) : null,
      status: "queued" as const,
      pct: 0,
    })),
    status: "running",
  };
  batches = [...batches, batch];
  emit();
  void run(id);
  return id;
}

/** Try a failed batch again. Uploads resume from whatever the server holds. */
export function retryOutgoing(id: string) {
  const batch = batches.find((entry) => entry.id === id);
  if (!batch || batch.status === "running") return;
  patchBatch(id, (current) => ({
    ...current,
    status: "running",
    error: undefined,
    files: current.files.map((entry) => ({ ...entry, status: "queued", pct: 0 })),
  }));
  void run(id);
}

/**
 * Give up on a batch, and on the part-uploads behind it.
 *
 * Without the cancel, the chunks already sent would wait out the server's
 * 24-hour sweep for a message the person has just abandoned.
 */
export function discardOutgoing(id: string) {
  const batch = batches.find((entry) => entry.id === id);
  batch?.files.forEach((entry) => void apiCancelUpload(entry.file));
  dropBatch(id);
}

async function deliver(target: OutgoingTarget, body: string, urls: string[]) {
  if (target.kind === "thread") {
    const parts = [body, ...urls].filter(Boolean);
    if (parts.length > 0) {
      await apiSendThreadMessage(
        target.roomId,
        target.threadEventId,
        parts.join("\n"),
        target.replyTo,
      );
    }
    return;
  }

  const channelId = target.channelId || undefined;
  if (body && urls.length > 0) {
    // Files + text: one combined message, so text and images are not split
    // into separate spoiler/reply messages.
    await apiSendMessage(
      target.roomId,
      [body, ...urls].join("\n"),
      target.replyTo,
      target.spoiler,
      channelId,
    );
    return;
  }
  // Files only: each as its own message.
  for (const url of urls) {
    await apiSendMessage(target.roomId, url, undefined, target.spoiler, channelId);
  }
  if (body) {
    await apiSendMessage(target.roomId, body, target.replyTo, target.spoiler, channelId);
  }
}

async function run(id: string) {
  const start = batches.find((batch) => batch.id === id);
  if (!start) return;

  // Several at once, rather than each file waiting out the one before it. The
  // wait was not only for the bytes: `complete` remuxes and probes on the
  // server, and the uplink sat idle through all of it, so ten files spent most
  // of their time sending nothing.
  const outcomes = await runPool(start.files, UPLOAD_CONCURRENCY, async (entry) => {
    // Discarding the batch stops the files that have not started yet.
    if (!batches.some((batch) => batch.id === id)) return null;
    patchFile(id, entry.id, "uploading", 0);
    try {
      const { url } = await apiUploadFile(entry.file, (pct) => {
        // At 100% the bytes are in and the server takes over — remuxing a
        // video can take longer than sending it did, and a bar sitting at
        // 100% looks like a hang.
        patchFile(id, entry.id, pct >= 100 ? "processing" : "uploading", pct);
      });
      patchFile(id, entry.id, "done", 100);
      return url;
    } catch {
      patchFile(id, entry.id, "failed", 0);
      return null;
    }
  });
  if (!batches.some((batch) => batch.id === id)) return;

  // Kept in staged order, not completion order: these are posted as the
  // message, and whichever file happened to be quickest is not the one that
  // should come first.
  const uploaded = outcomes.filter((url): url is string => url !== null);
  const failed = start.files.filter((_, index) => outcomes[index] === null);

  const current = batches.find((batch) => batch.id === id);
  if (!current) return;

  try {
    if (uploaded.length > 0 || current.body) {
      await deliver(current.target, current.body, uploaded);
    }
  } catch (err) {
    patchBatch(id, (batch) => ({
      ...batch,
      status: "failed",
      error: err instanceof Error ? err.message : "Could not send that message",
    }));
    return;
  }

  if (failed.length === 0) {
    dropBatch(id);
    return;
  }

  // What landed has been posted, so a retry must not post it again — only the
  // files that did not make it are still owed. The same rule the composer's
  // staged row has always followed: a failure halfway through a batch costs
  // the upload and not the file.
  patchBatch(id, (batch) => ({
    ...batch,
    body: "",
    files: failed.map((entry) => ({ ...entry, status: "failed", pct: 0 })),
    status: "failed",
    error:
      failed.length === 1
        ? `${failed[0].file.name} could not be uploaded`
        : `${failed.length} files could not be uploaded`,
  }));
}
