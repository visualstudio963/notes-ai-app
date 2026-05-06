/**
 * Register the service worker only. Versioning of /sw.js URL comes from the deploy-injected
 * HTML meta (same as asset ?v= hashes). No client-side version checks or forced reloads.
 */
(function () {
  "use strict";

  if (!("serviceWorker" in navigator)) return;

  var build =
    typeof window.__NOTES_AI_BUILD__ !== "undefined" && window.__NOTES_AI_BUILD__
      ? String(window.__NOTES_AI_BUILD__)
      : "";
  var el = document.querySelector('meta[name="notes-ai-build"]');
  var fromMeta = el && el.getAttribute("content");
  if (fromMeta && fromMeta !== "__BUILD_HASH__") build = build || String(fromMeta);
  if (!build) build = "dev";

  var swUrl = "/sw.js?v=" + encodeURIComponent(build);

  navigator.serviceWorker
    .register(swUrl, { scope: "/", updateViaCache: "none" })
    .then(function (reg) {
      return reg.update();
    })
    .catch(function () {
      /* offline or blocked */
    });
})();
