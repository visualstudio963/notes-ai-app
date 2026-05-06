/**
 * Service worker — navigations always network (no HTML shell cache). Other same-origin GET uses
 * network-first; cache used only as offline fallback. CACHE_NAME includes deploy id after build inject.
 */

const CACHE_NAME = "notes-ai-__BUILD_HASH__";

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
    if (url.pathname === "/sw.js" || url.pathname.startsWith("/sw.js")) return false;
    return true;
  } catch {
    return false;
  }
}

function isNavigationOrHtml(request) {
  if (request.mode === "navigate") return true;
  const accept = request.headers.get("accept") || "";
  return accept.includes("text/html");
}

self.addEventListener("fetch", (event) => {
  if (!shouldHandleFetch(event.request)) return;
  const req = event.request;

  if (isNavigationOrHtml(req)) {
    event.respondWith(fetch(req));
    return;
  }

  event.respondWith(
    fetch(req)
      .then((networkResponse) => {
        if (
          networkResponse &&
          networkResponse.ok &&
          networkResponse.type === "basic" &&
          req.method === "GET"
        ) {
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
