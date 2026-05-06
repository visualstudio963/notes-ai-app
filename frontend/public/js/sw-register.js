/**
 * Deploy-aware service worker lifecycle: purge stale registrations when build id changes,
 * register versioned sw.js, check for updates, reload once when a new worker activates.
 */
(function () {
  "use strict";

  try {
    var build =
      typeof window.__NOTES_AI_BUILD__ !== "undefined" && window.__NOTES_AI_BUILD__
        ? String(window.__NOTES_AI_BUILD__)
        : "";

    var el = document.querySelector('meta[name="notes-ai-build"]');
    var fromMeta = el && el.getAttribute("content");
    if (fromMeta && fromMeta !== "__BUILD_HASH__") build = build || String(fromMeta);
    if (!build) build = "dev";

    var storageKey = "notes_ai_deploy_build";

    /** When deploy id changes: drop workers + Cache Storage, reload once — fixes stale SPA shells. */
    function runMigrationMaybe(thenFn) {
      try {
        var prev = localStorage.getItem(storageKey);
        if (prev && prev !== build) {
          localStorage.setItem(storageKey, build);
          function reloadNow() {
            try {
              window.location.reload();
            } catch (_) {}
          }

          var pUnregister =
            typeof navigator.serviceWorker !== "undefined"
              ? navigator.serviceWorker.getRegistrations().then(function (regs) {
                  return Promise.all(
                    regs.map(function (reg) {
                      return reg.unregister();
                    })
                  );
                })
              : Promise.resolve();

          pUnregister
            .then(function () {
              if (typeof caches === "undefined" || !caches.keys) return Promise.resolve();
              return caches.keys().then(function (keys) {
                return Promise.all(
                  keys.map(function (key) {
                    return caches.delete(key);
                  })
                );
              });
            })
            .then(reloadNow, reloadNow);

          return;
        }
        if (!prev) localStorage.setItem(storageKey, build);
      } catch (_) {
        /* ignore */
      }
      if (typeof thenFn === "function") thenFn();
    }

    if (!("serviceWorker" in navigator)) return;

    var swUrl = "/sw.js?v=" + encodeURIComponent(build);

    function registerAndMaintain() {
      var refreshing = false;
      navigator.serviceWorker.addEventListener("controllerchange", function () {
        if (refreshing) return;
        var last = sessionStorage.getItem("notes_ai_sw_reload_ts");
        var now = Date.now();
        if (last && now - parseInt(last, 10) < 4000) return;
        refreshing = true;
        sessionStorage.setItem("notes_ai_sw_reload_ts", String(now));
        try {
          window.location.reload();
        } catch (_) {
          refreshing = false;
        }
      });

      navigator.serviceWorker
        .register(swUrl, { scope: "/", updateViaCache: "none" })
        .then(function (reg) {
          return reg.update();
        })
        .catch(function () {
          /* offline or blocked */
        });
    }

    runMigrationMaybe(registerAndMaintain);
  } catch (_) {
    /* ignore */
  }
})();
