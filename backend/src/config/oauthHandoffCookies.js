/** Short-lived HTTP-only cookies used only to bridge Google OAuth callback → SPA (no tokens in URL). */

const OAUTH_HANDOFF_AT = "na_oauth_at";
const OAUTH_HANDOFF_RT = "na_oauth_rt";

/** First-party hint: external browser OAuth may not round-trip custom session fields reliably; mirrors ?native=1. */
const OAUTH_NATIVE_HINT = "na_oauth_native";

/** Time window for the SPA to call POST /api/auth/oauth-handoff (mobile + slow networks). */
const OAUTH_HANDOFF_MAX_AGE_MS = 5 * 60 * 1000;

function getOAuthHandoffSetCookieOptions(isProduction) {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax",
    path: "/",
    maxAge: OAUTH_HANDOFF_MAX_AGE_MS
  };
}

/**
 * @param {import("express").Response} res
 * @param {boolean} isProduction
 */
function clearOAuthHandoffCookies(res, isProduction) {
  const base = {
    path: "/",
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax"
  };
  res.clearCookie(OAUTH_HANDOFF_AT, base);
  res.clearCookie(OAUTH_HANDOFF_RT, base);
}

/** Short TTL: only needs to survive Google's round-trip. */
function getOAuthNativeHintCookieOptions(isProduction) {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax",
    path: "/",
    maxAge: 12 * 60 * 1000
  };
}

function clearOAuthNativeHintCookie(res, isProduction) {
  const base = {
    path: "/",
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax"
  };
  res.clearCookie(OAUTH_NATIVE_HINT, base);
}

module.exports = {
  OAUTH_HANDOFF_AT,
  OAUTH_HANDOFF_RT,
  OAUTH_NATIVE_HINT,
  OAUTH_HANDOFF_MAX_AGE_MS,
  getOAuthHandoffSetCookieOptions,
  getOAuthNativeHintCookieOptions,
  clearOAuthHandoffCookies,
  clearOAuthNativeHintCookie
};
