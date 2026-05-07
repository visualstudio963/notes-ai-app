/* global window */
(function initApiBaseUrl(globalScope) {
  const FALLBACK_API_URL = "https://notes-ai-app.onrender.com";

  function readMetaApiBase() {
    try {
      if (!globalScope.document || !globalScope.document.querySelector) return "";
      const el = globalScope.document.querySelector('meta[name="notes-ai-api-base"]');
      const raw = el && el.getAttribute("content");
      const c = typeof raw === "string" ? raw.trim() : "";
      if (!c || c === "__API_BASE_URL__") return "";
      return c.replace(/\/+$/, "");
    } catch {
      return "";
    }
  }

  function readViteApiUrl() {
    try {
      const viaImportMeta = (0, eval)("import.meta.env.VITE_API_URL");
      if (typeof viaImportMeta === "string" && viaImportMeta.trim()) {
        return viaImportMeta.trim();
      }
    } catch {
      /* Running without Vite/module context; ignore. */
    }
    const injected =
      globalScope &&
      globalScope.__APP_ENV__ &&
      typeof globalScope.__APP_ENV__.VITE_API_URL === "string"
        ? globalScope.__APP_ENV__.VITE_API_URL.trim()
        : "";
    if (injected && injected !== "__API_BASE_URL__") return injected;
    return "";
  }

  function isNativeApp() {
    try {
      if (typeof globalScope.isNativeApp === "function") return globalScope.isNativeApp() === true;
    } catch {
      /* ignore */
    }
    return false;
  }

  const fromMeta = readMetaApiBase();
  const fromVite = readViteApiUrl();
  let resolvedBase = fromMeta || fromVite || "";
  if (!resolvedBase) resolvedBase = FALLBACK_API_URL;

  /* APK / Capacitor must never call relative APIs — force absolute backend */
  if (isNativeApp()) {
    resolvedBase = fromMeta || fromVite || FALLBACK_API_URL;
    if (!/^https:\/\//i.test(resolvedBase)) {
      resolvedBase = FALLBACK_API_URL;
    }
  }

  const normalizedBaseUrl = String(resolvedBase || "").replace(/\/+$/, "");

  function buildApiUrl(path) {
    const normalizedPath = String(path || "").trim();
    if (!normalizedPath) return normalizedBaseUrl;
    if (/^https?:\/\//i.test(normalizedPath)) return normalizedPath;
    return `${normalizedBaseUrl}${normalizedPath.startsWith("/") ? normalizedPath : `/${normalizedPath}`}`;
  }

  globalScope.API_BASE_URL = normalizedBaseUrl;
  globalScope.buildApiUrl = buildApiUrl;
})(typeof window !== "undefined" ? window : globalThis);
