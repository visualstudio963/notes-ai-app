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
