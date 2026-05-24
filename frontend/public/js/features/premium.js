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
  if (cap && typeof cap === "object" && cap.webChat === true) return true;

  const expMs = resolveStandardExpiresAtMs(user);
  if (expMs != null) {
    return expMs > Date.now();
  }

  if (user.standardActive === true) return true;

  const life = user.lifecycle ? String(user.lifecycle).toLowerCase() : "";
  if (life === "trial" || life === "standard") return true;

  const role = String(user.membershipRole || "");
  const tier = String(user.tier || "");
  const plan = String(user.plan || user.subscriptionPlan || "");
  const normalizedTier = tier === "premium" ? "standard" : tier;
  const normalizedPlan = plan === "premium" ? "standard" : plan;
  const normalizedRole = role === "premium" ? "standard" : role;
  return (
    normalizedRole === "standard" ||
    normalizedTier === "standard" ||
    normalizedPlan === "standard"
  );
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
