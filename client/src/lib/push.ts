/**
 * Web Push enrollment.
 *
 * Desktop notifications in `notifications.ts` only fire while a tab is open —
 * they are raised by the page itself from a WebSocket event. Push is the other
 * half: the server reaching a browser that has no tab at all. The two never
 * overlap, because the server skips anyone holding a live connection.
 *
 * Everything here degrades quietly. A browser without a service worker, a
 * server with no VAPID key, an iOS home screen the user hasn't added yet — all
 * of them end with push simply off, never with a broken app.
 */

import { apiGetPushPublicKey, apiPushSubscribe, apiPushUnsubscribe } from "./api";

/** Where the enrolled state is remembered between loads, per browser. */
const ENABLED_KEY = "chatter_push_enabled";

export type PushSupport =
  | "supported"
  /** No service worker or PushManager — an older browser, or a non-secure origin. */
  | "unsupported"
  /** iOS only exposes push to an app added to the home screen. */
  | "needs-install";

export function pushSupport(): PushSupport {
  if (typeof window === "undefined") return "unsupported";
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    // Safari on iOS hides both until the app is installed, so the distinction
    // is worth drawing: one is "never", the other is "not yet".
    const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const installed = window.matchMedia("(display-mode: standalone)").matches;
    return isIos && !installed ? "needs-install" : "unsupported";
  }
  return "supported";
}

/** Whether this browser has been enrolled, as far as it last knew. */
export function pushEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberEnabled(enabled: boolean) {
  try {
    if (enabled) localStorage.setItem(ENABLED_KEY, "1");
    else localStorage.removeItem(ENABLED_KEY);
  } catch {
    // Private browsing: enrollment still works for this session.
  }
}

/**
 * Register the service worker. Safe to call repeatedly — the browser returns
 * the existing registration and updates it in the background.
 */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (pushSupport() !== "supported") return null;
  try {
    return await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  } catch {
    return null;
  }
}

/**
 * The server's VAPID public key, as the bytes `PushManager.subscribe` wants.
 *
 * Backed by an explicit ArrayBuffer: `applicationServerKey` will not accept a
 * view that might sit on a SharedArrayBuffer.
 */
export function decodeVapidKey(base64: string): Uint8Array<ArrayBuffer> {
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** The inverse of `decodeVapidKey`, in the unpadded form the server sends.
 *
 *  Exported alongside its inverse so the round trip can be tested: the two have
 *  to agree with `b64url_encode` in src/backend/webpush.rs exactly, or every
 *  load decides the key has changed and re-enrols a device that was fine. */
export function encodeVapidKey(key: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(key)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Whether a subscription was enrolled with the key this server signs with now.
 *
 * A subscription is bound to the application server key it was created with,
 * and the browser has no idea when that key changes: `getSubscription()` goes
 * on returning a perfectly valid object that the push service will refuse for
 * the rest of its life. Nothing else in the app can notice — the enrollment
 * call succeeds, the row is stored, and every push is rejected far away with a
 * 403 nobody sees.
 *
 * So the two are compared here, on every load. A browser that cannot tell us
 * which key it used (no `options`, older Safari) is given the benefit of the
 * doubt: re-subscribing on a guess would drop a subscription that works.
 */
function matchesServerKey(subscription: PushSubscription, publicKey: string): boolean {
  const enrolled = subscription.options?.applicationServerKey;
  if (!enrolled) return true;
  return encodeVapidKey(enrolled) === publicKey;
}

/**
 * Subscribe with the server's current key, retiring anything enrolled under an
 * older one first.
 *
 * The retirement is not optional: `subscribe()` with an `applicationServerKey`
 * different from the existing subscription's throws `InvalidStateError`. That
 * is what made a changed VAPID key unrecoverable from inside the app — push
 * stopped arriving, and switching it off and on again failed at this very
 * call, so the one thing anybody would try could not work either.
 */
async function subscribeWithCurrentKey(
  registration: ServiceWorkerRegistration,
  publicKey: string,
): Promise<PushSubscription> {
  const existing = await registration.pushManager.getSubscription();
  if (existing) {
    if (matchesServerKey(existing, publicKey)) return existing;
    // Tell the server before dropping it locally, or the row outlives the
    // endpoint and the next push goes to something nothing answers.
    await apiPushUnsubscribe(existing.endpoint).catch(() => {});
    await existing.unsubscribe();
  }
  return registration.pushManager.subscribe({
    // Chrome refuses a subscription that cannot show a notification, and
    // showing one for every message is what we do anyway.
    userVisibleOnly: true,
    applicationServerKey: decodeVapidKey(publicKey),
  });
}

/** A subscription in the shape the server stores. */
function serialize(subscription: PushSubscription) {
  const json = subscription.toJSON();
  return {
    endpoint: subscription.endpoint,
    keys: {
      p256dh: json.keys?.p256dh ?? "",
      auth: json.keys?.auth ?? "",
    },
  };
}

/**
 * Enrol this browser for push, asking for notification permission if needed.
 *
 * Must be called from a user gesture: the permission prompt is refused
 * otherwise. Returns the resulting permission so the caller can explain a
 * refusal rather than silently doing nothing.
 */
export async function enablePush(): Promise<NotificationPermission | "unsupported"> {
  if (pushSupport() !== "supported") return "unsupported";

  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission;

  const { enabled, public_key } = await apiGetPushPublicKey();
  if (!enabled || !public_key) return "unsupported";

  const registration = await registerServiceWorker();
  if (!registration) return "unsupported";
  // A registration that is still installing has no pushManager yet.
  await navigator.serviceWorker.ready;

  const subscription = await subscribeWithCurrentKey(registration, public_key);

  await apiPushSubscribe(serialize(subscription));
  rememberEnabled(true);
  return "granted";
}

/** Retire this browser's subscription, on the server and in the browser. */
export async function disablePush(): Promise<void> {
  rememberEnabled(false);
  if (pushSupport() !== "supported") return;
  try {
    const registration = await navigator.serviceWorker.getRegistration("/");
    const subscription = await registration?.pushManager.getSubscription();
    if (!subscription) return;
    // Tell the server first: if unsubscribing locally succeeds and the call
    // fails, the server would keep pushing to an endpoint nothing answers.
    await apiPushUnsubscribe(subscription.endpoint).catch(() => {});
    await subscription.unsubscribe();
  } catch {
    // Nothing to retire.
  }
}

/**
 * Re-send the current subscription on app start, for a browser already enrolled.
 *
 * Push services rotate endpoints, and a browser can drop a subscription on its
 * own; the service worker cannot re-register it because it has no session to
 * authenticate with. Re-syncing whenever the app loads is what repairs both,
 * and it costs one request.
 */
export async function syncPushSubscription(): Promise<void> {
  if (!pushEnabled() || pushSupport() !== "supported") return;
  if (Notification.permission !== "granted") {
    // Permission was revoked in browser settings — stop claiming enrollment.
    rememberEnabled(false);
    return;
  }
  try {
    const registration = await registerServiceWorker();
    if (!registration) return;
    await navigator.serviceWorker.ready;

    // The key is fetched even when a subscription already exists, because
    // "already subscribed" is not the same as "subscribed to this server".
    // This is the request that catches a VAPID key that has moved on, and it
    // is the only chance to catch it: every other signal is a silent refusal
    // on the far side of a push service.
    const { enabled, public_key } = await apiGetPushPublicKey();
    if (!enabled || !public_key) return;

    const subscription = await subscribeWithCurrentKey(registration, public_key);
    await apiPushSubscribe(serialize(subscription));
  } catch {
    // Leave the remembered state alone: a transient failure now should not
    // switch push off for good.
  }
}
