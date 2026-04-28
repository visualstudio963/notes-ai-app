/* global window */
(function initApiBaseUrl(globalScope) {
  const FALLBACK_API_URL = "https://notes-ai-backend-lykf.onrender.com";

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

  const rawBaseUrl = readViteApiUrl() || FALLBACK_API_URL;
  const normalizedBaseUrl = rawBaseUrl.replace(/\/+$/, "");

  function buildApiUrl(path) {
    const normalizedPath = String(path || "").trim();
    if (!normalizedPath) return normalizedBaseUrl;
    if (/^https?:\/\//i.test(normalizedPath)) return normalizedPath;
    return `${normalizedBaseUrl}${normalizedPath.startsWith("/") ? normalizedPath : `/${normalizedPath}`}`;
  }

  globalScope.API_BASE_URL = normalizedBaseUrl;
  globalScope.buildApiUrl = buildApiUrl;
})(typeof window !== "undefined" ? window : globalThis);
