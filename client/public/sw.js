/**
 * Chatter's service worker.
 *
 * It exists for one job: receiving push messages when no tab is open. There is
 * no offline caching here — the app is a live socket onto a server, and a
 * cached shell that cannot reach it is worse than an honest failure to load.
 *
 * Served from the site root so its scope covers the whole app; see the /sw.js
 * route in backend/routes/static_content.rs.
 */

// Take over as soon as a new version is installed rather than waiting for
// every tab to close. A stale worker would keep delivering with the old
// payload shape after the server had moved on.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

/** The payload the server encrypts, with anything missing filled in safely. */
function readPayload(event) {
  const fallback = {
    title: "Chatter",
    body: "New message",
    icon: "",
    tag: "chatter",
    room_id: "",
    channel_id: "",
  };
  if (!event.data) return fallback;
  try {
    return { ...fallback, ...event.data.json() };
  } catch {
    // A push with a non-JSON body still means something arrived.
    return { ...fallback, body: event.data.text() || fallback.body };
  }
}

self.addEventListener("push", (event) => {
  const payload = readPayload(event);
  event.waitUntil(
    (async () => {
      // A tab that is open and focused has already shown this itself, off the
      // WebSocket. The server suppresses that case by skipping connected
      // users, but a socket can be closing exactly as the message lands.
      const clients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      if (clients.some((client) => client.visibilityState === "visible" && client.focused)) {
        return;
      }

      await self.registration.showNotification(payload.title, {
        body: payload.body,
        icon: payload.icon || "/icon-192.png",
        badge: "/icon-badge.png",
        // Matches the tag the in-page path uses, so a burst from one channel
        // collapses into a single notification instead of a stack.
        tag: payload.tag,
        renotify: true,
        timestamp: Date.now(),
        data: {
          roomId: payload.room_id,
          channelId: payload.channel_id,
        },
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const { roomId, channelId } = event.notification.data || {};

  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });

      // Prefer an app window that already exists: focusing it and telling it
      // where to go keeps the socket and any call alive, where opening a new
      // window would tear both down.
      for (const client of clients) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        await client.focus();
        client.postMessage({ type: "notification-navigate", roomId, channelId });
        return;
      }

      // Nothing open — carry the destination in the URL instead.
      const params = new URLSearchParams();
      if (roomId) params.set("room", roomId);
      if (channelId) params.set("channel", channelId);
      const query = params.toString();
      await self.clients.openWindow(query ? `/?${query}` : "/");
    })(),
  );
});
