/** Short-lived HTTP-only cookies used only to bridge Google OAuth callback → SPA (no tokens in URL). */

const OAUTH_HANDOFF_AT = "na_oauth_at";
const OAUTH_HANDOFF_RT = "na_oauth_rt";

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

module.exports = {
  OAUTH_HANDOFF_AT,
  OAUTH_HANDOFF_RT,
  OAUTH_HANDOFF_MAX_AGE_MS,
  getOAuthHandoffSetCookieOptions,
  clearOAuthHandoffCookies
};
