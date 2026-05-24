/* global window */
(function initApiBaseUrl(globalScope) {
  const FALLBACK_API_URL = "https://notes-ai-app.onrender.com";
  const FALLBACK_PUBLIC_APP_URL = "https://notesai.space";

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

  function readMetaPublicAppUrl() {
    try {
      if (!globalScope.document || !globalScope.document.querySelector) return "";
      const el = globalScope.document.querySelector('meta[name="notes-ai-public-url"]');
      const raw = el && el.getAttribute("content");
      const c = typeof raw === "string" ? raw.trim() : "";
      if (!c || c === "__PUBLIC_APP_URL__") return "";
      return c.replace(/\/+$/, "");
    } catch {
      return "";
    }
  }

  function readPublicAppUrlEnv() {
    try {
      const injected =
        globalScope &&
        globalScope.__APP_ENV__ &&
        typeof globalScope.__APP_ENV__.PUBLIC_APP_URL === "string"
          ? globalScope.__APP_ENV__.PUBLIC_APP_URL.trim()
          : "";
      if (injected && injected !== "__PUBLIC_APP_URL__") return injected.replace(/\/+$/, "");
    } catch {
      /* ignore */
    }
    return "";
  }

  function isLocalWebOrigin(origin) {
    return /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(String(origin || "").trim());
  }

  function resolvePublicAppOrigin() {
    const fromMeta = readMetaPublicAppUrl();
    const fromEnv = readPublicAppUrlEnv();
    const fallback = fromMeta || fromEnv || FALLBACK_PUBLIC_APP_URL;

    function finalize(origin) {
      const normalized = String(origin || "").replace(/\/+$/, "");
      if (!isLocalWebOrigin(normalized)) return normalized || fallback;
      if (isNativeApp()) return fallback;
      try {
        const host = globalScope.location.hostname || "";
        if (host === "localhost" || host === "127.0.0.1") return normalized;
      } catch {
        /* ignore */
      }
      return fallback;
    }

    if (isNativeApp()) {
      return finalize(fallback);
    }

    try {
      const origin = String(globalScope.location.origin || "").replace(/\/+$/, "");
      const host = globalScope.location.hostname || "";
      const isDevWeb = host === "localhost" || host === "127.0.0.1";
      if (isDevWeb && origin) return finalize(origin);
      if (fromMeta) return finalize(fromMeta);
      if (fromEnv) return finalize(fromEnv);
      if (origin && !isLocalWebOrigin(origin)) return finalize(origin);
    } catch {
      /* ignore */
    }

    return finalize(fallback);
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
  const publicAppOrigin = resolvePublicAppOrigin();

  function buildApiUrl(path) {
    const normalizedPath = String(path || "").trim();
    if (!normalizedPath) return normalizedBaseUrl;
    if (/^https?:\/\//i.test(normalizedPath)) return normalizedPath;
    return `${normalizedBaseUrl}${normalizedPath.startsWith("/") ? normalizedPath : `/${normalizedPath}`}`;
  }

  globalScope.API_BASE_URL = normalizedBaseUrl;
  globalScope.PUBLIC_APP_ORIGIN = publicAppOrigin;
  globalScope.getPublicAppOrigin = function getPublicAppOrigin() {
    return publicAppOrigin;
  };
  globalScope.buildApiUrl = buildApiUrl;
})(typeof window !== "undefined" ? window : globalThis);
