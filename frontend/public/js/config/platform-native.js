/* global window, document */
/**
 * Capacitor / native WebView detection. Loaded before api-base.js.
 * Web and PWA behavior is unchanged when these return false.
 */
(function initPlatformNative(globalScope) {
  "use strict";

  function isCapacitorRuntime() {
    try {
      return Boolean(
        globalScope.Capacitor && typeof globalScope.Capacitor.isNativePlatform === "function"
      );
    } catch {
      return false;
    }
  }

  function isNativeApp() {
    try {
      if (!isCapacitorRuntime()) return false;
      return globalScope.Capacitor.isNativePlatform() === true;
    } catch {
      return false;
    }
  }

  globalScope.isNativeApp = isNativeApp;
  globalScope.isCapacitorRuntime = isCapacitorRuntime;
  globalScope.__NOTES_AI_NATIVE__ = isNativeApp();

  function markNativeClass() {
    try {
      if (typeof document === "undefined" || !document.documentElement) return;
      document.documentElement.classList.toggle("capacitor-native", isNativeApp());
    } catch {
      /* ignore */
    }
  }

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", markNativeClass, { once: true });
    } else {
      markNativeClass();
    }
  }

  /** Quiet diagnostics — avoids silent failures masking real bugs in devtools */
  if (typeof globalScope.addEventListener === "function") {
    globalScope.addEventListener(
      "error",
      function (ev) {
        try {
          if (globalScope.__NOTES_AI_NATIVE__ && globalScope.console && globalScope.console.warn) {
            globalScope.console.warn("[Notes AI]", ev && (ev.error || ev.message));
          }
        } catch {
          /* ignore */
        }
      },
      true
    );
    globalScope.addEventListener("unhandledrejection", function (ev) {
      try {
        if (globalScope.__NOTES_AI_NATIVE__ && globalScope.console && globalScope.console.warn) {
          globalScope.console.warn("[Notes AI] unhandled rejection", ev && ev.reason);
        }
      } catch {
        /* ignore */
      }
    });
  }
})(typeof window !== "undefined" ? window : globalThis);
