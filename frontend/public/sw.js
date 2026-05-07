/**
 * Offline-only: same-origin static GET (not navigations). Network first, cache on success,
 * fallback to cache when offline. HTML is never handled here — left to the browser + CDN headers.
 */

const CACHE_NAME = "notes-ai-offline-static";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)))
      )
      .then(() => self.clients.claim())
  );
});

function shouldHandleFetch(request) {
  if (request.method !== "GET") return false;
  if (request.mode === "navigate") return false;
  try {
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return false;
    if (url.pathname.startsWith("/api")) return false;
    if (url.pathname === "/sw.js" || url.pathname.startsWith("/sw.js")) return false;
    return true;
  } catch {
    return false;
  }
}

self.addEventListener("fetch", (event) => {
  if (!shouldHandleFetch(event.request)) return;
  const req = event.request;

  event.respondWith(
    fetch(req)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.ok && networkResponse.type === "basic") {
          const copy = networkResponse.clone();
          caches
            .open(CACHE_NAME)
            .then((cache) => cache.put(req, copy))
            .catch(() => {});
        }
        return networkResponse;
      })
      .catch(() => caches.match(req))
  );
});

/** Focus an open client or open the start URL; never use window.open from the page for notifications. */
self.addEventListener("notificationclick", (event) => {
  const n = event.notification;
  if (n) n.close();
  const data = (n && n.data) || {};
  const rawUrl = typeof data.url === "string" && data.url ? data.url : self.registration.scope;
  let targetUrl = rawUrl;
  try {
    targetUrl = new URL(rawUrl, self.registration.scope).href;
  } catch {
    /* use rawUrl */
  }
  const reminderId = data.reminderId != null ? data.reminderId : undefined;

  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const scopeOrigin = new URL(self.registration.scope).origin;
      for (const client of all) {
        try {
          if (String(client.url || "").startsWith(scopeOrigin) && "focus" in client) {
            await client.focus();
            client.postMessage({ type: "NOTIFICATION_CLICK", reminderId, url: targetUrl });
            return;
          }
        } catch {
          /* try next */
        }
      }
      if (self.clients.openWindow) {
        await self.clients.openWindow(targetUrl);
      }
    })()
  );
});
