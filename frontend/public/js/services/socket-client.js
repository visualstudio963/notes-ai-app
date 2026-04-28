/** @type {import("socket.io-client").Socket | { emit: Function; on: Function }} */
var socket;
(function initSocket() {
  try {
    var targetUrl =
      typeof window !== "undefined" && typeof window.API_BASE_URL === "string" && window.API_BASE_URL.trim()
        ? window.API_BASE_URL.trim()
        : undefined;
    socket = io(targetUrl, {
      path: "/socket.io",
      transports: ["websocket", "polling"],
      timeout: 8000,
      reconnectionAttempts: 5
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
