/** @type {import("socket.io-client").Socket | { emit: Function; on: Function }} */
var socket;
(function initSocket() {
  try {
    socket = io();
    socket.on("error", () => {});
    socket.on("disconnect", () => {});
  } catch {
    socket = {
      emit: () => {},
      on: () => {}
    };
  }
})();
