/** @type {import("socket.io-client").Socket | { emit: Function; on: Function }} */
var socket;

(function initSocket() {
  "use strict";

  var noopSocket = {
    emit: function () {},
    on: function () {}
  };

  function isNativeCapacitor() {
    try {
      return typeof isNativeApp === "function" && isNativeApp();
    } catch {
      return false;
    }
  }

  function connectRealtimeSocket() {
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

    /** APK: defer socket.io handshake until after login (lighter cold start). */
    if (isNativeCapacitor()) {
      window.__notesAiEnsureSocket = function notesAiEnsureSocket() {
        if (socket && socket !== noopSocket) return socket;
        socket = connectRealtimeSocket();
        if (typeof window.__notesAiOnSocketReady === "function") {
          window.__notesAiOnSocketReady(socket);
        }
        return socket;
      };
      return;
    }

    socket = connectRealtimeSocket();
  } catch {
    socket = noopSocket;
  }
})();
