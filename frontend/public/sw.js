/**
 * Service worker — network-first for HTML/JS/CSS so normal reloads get fresh assets.
 * Falls back to cache only when offline (or network failure).
 * API requests are not intercepted.
 */

const CACHE_NAME = "notes-ai-v3";

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
  try {
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return false;
    if (url.pathname.startsWith("/api")) return false;
    return true;
  } catch {
    return false;
  }
}

self.addEventListener("fetch", (event) => {
  if (!shouldHandleFetch(event.request)) return;

  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.ok && networkResponse.type === "basic") {
          const copy = networkResponse.clone();
          caches
            .open(CACHE_NAME)
            .then((cache) => cache.put(event.request, copy))
            .catch(() => {});
        }
        return networkResponse;
      })
      .catch(() => caches.match(event.request))
  );
});
