/**
 * Client-side plan helpers: Free vs Standard.
 * Server is authoritative; mirrors `/api/premium/status` and `publicUser`.
 * Access gate matches backend {@link hasStandardAccess}: trial, coins, Stripe share one rule.
 */

/**
 * Canonical Standard expiry (same field order as backend resolveStandardExpiresAt).
 * @param {Record<string, unknown> | null | undefined} user
 * @returns {number | null} ms since epoch, or null if none
 */
function resolveStandardExpiresAtMs(user) {
  if (!user) return null;
  const keys = [
    "standardExpiresAt",
    "premiumExpiresAt",
    "premiumExpires",
    "trialEndsAt",
    "standardCoinExpiresAt"
  ];
  for (let i = 0; i < keys.length; i += 1) {
    const raw = user[keys[i]];
    if (!raw) continue;
    const t = new Date(String(raw)).getTime();
    if (Number.isFinite(t)) return t;
  }
  return null;
}

/**
 * @param {Record<string, unknown> | null | undefined} user
 * @returns {boolean}
 */
function hasStandardAccess(user) {
  if (!user) return false;

  const cap = user.capabilities;
  if (cap && typeof cap === "object") {
    if (cap.webChat === true) return true;
    if (cap.webChat === false) return false;
  }

  if (user.standardActive === true) return true;
  if (user.standardActive === false) {
    const expMsWhenInactive = resolveStandardExpiresAtMs(user);
    if (expMsWhenInactive != null && expMsWhenInactive > Date.now()) return true;
    return false;
  }

  const expMs = resolveStandardExpiresAtMs(user);
  if (expMs != null) {
    return expMs > Date.now();
  }

  return false;
}

/** @deprecated Prefer {@link hasStandardAccess}. */
function userHasStandardTierFeatures(user) {
  return hasStandardAccess(user);
}

function userHasScanCamAccess(user) {
  return hasStandardAccess(user);
}

function userHasWebChatAccess(user) {
  return hasStandardAccess(user);
}

function userCanExportNoteTxt(user) {
  return Boolean(user);
}

function userCanExportNotePdf(user) {
  return hasStandardAccess(user);
}

function userCanExportNoteJpg(user) {
  return hasStandardAccess(user);
}

if (typeof window !== "undefined") {
  window.hasStandardAccess = hasStandardAccess;
}
