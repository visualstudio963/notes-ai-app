/* global window */
(function initApiBaseUrl(globalScope) {
  const FALLBACK_API_URL = "https://notes-ai-app.onrender.com";

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
    return injected || "";
  }

  function shouldUseSameOriginApi() {
    try {
      const host =
        globalScope &&
        globalScope.location &&
        typeof globalScope.location.hostname === "string"
          ? globalScope.location.hostname.toLowerCase()
          : "";
      return host.endsWith(".vercel.app");
    } catch {
      return false;
    }
  }

  const resolvedBase = readViteApiUrl() || (shouldUseSameOriginApi() ? "" : FALLBACK_API_URL);
  const normalizedBaseUrl = String(resolvedBase || "").replace(/\/+$/, "");

  function buildApiUrl(path) {
    const normalizedPath = String(path || "").trim();
    if (!normalizedPath) return normalizedBaseUrl;
    if (/^https?:\/\//i.test(normalizedPath)) return normalizedPath;
    if (!normalizedBaseUrl) return normalizedPath.startsWith("/") ? normalizedPath : `/${normalizedPath}`;
    return `${normalizedBaseUrl}${normalizedPath.startsWith("/") ? normalizedPath : `/${normalizedPath}`}`;
  }

  globalScope.API_BASE_URL = normalizedBaseUrl;
  globalScope.buildApiUrl = buildApiUrl;
})(typeof window !== "undefined" ? window : globalThis);
