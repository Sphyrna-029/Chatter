/**
 * Where a half-finished upload is remembered between attempts, and across a
 * reload.
 *
 * The upload id used to live in a local variable inside the function doing the
 * uploading, so a closed tab or a rejected promise lost it — and with it every
 * chunk the server had already accepted, which then sat on disk until the
 * sweeper took it a day later. All this holds is the id and the shape of the
 * file it belongs to; the server is asked what it actually has.
 *
 * What it deliberately does *not* hold is the file's bytes. A `File` is
 * structured-cloneable and IndexedDB would take one, but storing it copies the
 * whole thing into the browser's profile — for the multi-gigabyte videos this
 * feature exists for, that is a second copy of the file on the same disk, and
 * likely a quota refusal. The file itself has to still be in hand: staged on
 * the composer, or picked again. Recognising it is what the fingerprint is for.
 *
 * Every operation degrades to nothing if IndexedDB is unavailable — a private
 * window, a browser with storage switched off. Resume is an improvement on
 * starting over, never a requirement for it, so it must not be able to fail an
 * upload.
 */

const DB_NAME = "chatter-uploads";
const DB_VERSION = 1;
const STORE = "resumable";

/**
 * Longer than the server's 24-hour idle sweep, so a record is only dropped
 * locally once the chunks behind it are certainly gone.
 */
const RECORD_TTL_MS = 25 * 60 * 60 * 1000;

export interface ResumableUpload {
  /** Primary key — see `fingerprintFile`. */
  fingerprint: string;
  uploadId: string;
  name: string;
  size: number;
  /** Chunk indices this client believes landed. A hint for the UI; the server
   *  is authoritative and is asked before anything is skipped. */
  sent: number[];
  chunkSize: number;
  updatedAt: number;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "fingerprint" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    // Another tab holding an old version open. Nothing to wait for.
    request.onblocked = () => resolve(null);
  });
  return dbPromise;
}

function run<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) {
          resolve(null);
          return;
        }
        try {
          const tx = db.transaction(STORE, mode);
          const request = work(tx.objectStore(STORE));
          request.onsuccess = () => resolve(request.result ?? null);
          request.onerror = () => resolve(null);
          tx.onabort = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

/** What is remembered about this file, if anything, and if it is still fresh. */
export async function loadResumable(fingerprint: string): Promise<ResumableUpload | null> {
  const record = await run<ResumableUpload>("readonly", (store) => store.get(fingerprint));
  if (!record) return null;
  if (Date.now() - record.updatedAt > RECORD_TTL_MS) {
    await forgetResumable(fingerprint);
    return null;
  }
  return record;
}

export async function saveResumable(record: Omit<ResumableUpload, "updatedAt">): Promise<void> {
  await run("readwrite", (store) => store.put({ ...record, updatedAt: Date.now() }));
}

export async function forgetResumable(fingerprint: string): Promise<void> {
  await run("readwrite", (store) => store.delete(fingerprint));
}

/**
 * Everything still unfinished, newest first, with anything past its life
 * already removed.
 *
 * The staging dirs behind expired records are gone from the server too, so
 * pruning here is not losing anything that could have been resumed.
 */
export async function listResumable(): Promise<ResumableUpload[]> {
  const all = (await run<ResumableUpload[]>("readonly", (store) => store.getAll())) ?? [];
  const cutoff = Date.now() - RECORD_TTL_MS;
  const expired = all.filter((record) => record.updatedAt <= cutoff);
  await Promise.all(expired.map((record) => forgetResumable(record.fingerprint)));
  return all
    .filter((record) => record.updatedAt > cutoff)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
