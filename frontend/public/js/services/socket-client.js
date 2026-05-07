/** @type {import("socket.io-client").Socket | { emit: Function; on: Function }} */
var socket;
(function initSocket() {
  try {
    var host =
      typeof window !== "undefined" && window.location && typeof window.location.hostname === "string"
        ? window.location.hostname.toLowerCase()
        : "";
    var isVercelHost = host.endsWith(".vercel.app");
    var realtimeOptIn = typeof window !== "undefined" && window.__ENABLE_REALTIME__ === true;
    if (isVercelHost && !realtimeOptIn) {
      socket = {
        emit: () => {},
        on: () => {}
      };
      return;
    }
    var targetUrl =
      typeof window !== "undefined" && window.API_BASE_URL
        ? String(window.API_BASE_URL).replace(/\/+$/, "")
        : "https://notes-ai-app.onrender.com";
    socket = io(targetUrl, {
      path: "/socket.io",
      transports: ["websocket", "polling"],
      timeout: 8000,
      reconnectionAttempts: 2
    });
    socket.on("error", () => {});
    socket.on("disconnect", () => {});
  } catch {
    socket = {
      emit: () => {},
      on: () => {}
    };
  }
})();
