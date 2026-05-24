/** @type {import("socket.io-client").Socket | { emit: Function; on: Function }} */
var socket;

(function initSocket() {
  "use strict";

  var noopSocket = {
    emit: function () {},
    on: function () {}
  };

  var socketIoScriptPromise = null;

  function loadSocketIoScript() {
    if (typeof io === "function") return Promise.resolve();
    if (socketIoScriptPromise) return socketIoScriptPromise;
    socketIoScriptPromise = new Promise(function (resolve, reject) {
      var existing = document.querySelector('script[data-notes-ai-vendor="socket-io"]');
      if (existing) {
        if (existing.dataset.loaded === "1") {
          resolve();
          return;
        }
        existing.addEventListener("load", function () {
          resolve();
        }, { once: true });
        existing.addEventListener("error", function () {
          reject(new Error("socket_io_load_failed"));
        }, { once: true });
        return;
      }
      var s = document.createElement("script");
      s.src = "https://cdn.socket.io/4.7.2/socket.io.min.js";
      s.async = true;
      s.dataset.notesAiVendor = "socket-io";
      s.onload = function () {
        s.dataset.loaded = "1";
        resolve();
      };
      s.onerror = function () {
        socketIoScriptPromise = null;
        reject(new Error("socket_io_load_failed"));
      };
      document.head.appendChild(s);
    });
    return socketIoScriptPromise;
  }

  function isNativeCapacitor() {
    try {
      return typeof isNativeApp === "function" && isNativeApp();
    } catch {
      return false;
    }
  }

  function connectRealtimeSocket() {
    return loadSocketIoScript()
      .then(function () {
        if (typeof io !== "function") return noopSocket;
        var targetUrl =
          typeof window !== "undefined" && window.API_BASE_URL
            ? String(window.API_BASE_URL).replace(/\/+$/, "")
            : "https://notes-ai-app.onrender.com";
        var s = io(targetUrl, {
          path: "/socket.io",
          transports: ["websocket", "polling"],
          timeout: 8000,
          reconnectionAttempts: 2
        });
        s.on("error", function () {});
        s.on("disconnect", function () {});
        return s;
      })
      .catch(function () {
        return noopSocket;
      });
  }

  function ensureSocketConnected() {
    if (socket && socket !== noopSocket) return Promise.resolve(socket);
    return connectRealtimeSocket().then(function (s) {
      socket = s;
      if (typeof window.__notesAiOnSocketReady === "function") {
        window.__notesAiOnSocketReady(socket);
      }
      return socket;
    });
  }

  try {
    var host =
      typeof window !== "undefined" && window.location && typeof window.location.hostname === "string"
        ? window.location.hostname.toLowerCase()
        : "";
    var isVercelHost = host.endsWith(".vercel.app");
    var realtimeOptIn = typeof window !== "undefined" && window.__ENABLE_REALTIME__ === true;

    socket = noopSocket;

    if (isVercelHost && !realtimeOptIn) {
      return;
    }

    window.__notesAiEnsureSocket = function notesAiEnsureSocket() {
      if (socket && socket !== noopSocket) return socket;
      void ensureSocketConnected();
      return socket;
    };

    /** Defer socket.io until app.js calls __notesAiEnsureSocket after auth. */
  } catch {
    socket = noopSocket;
  }
})();
