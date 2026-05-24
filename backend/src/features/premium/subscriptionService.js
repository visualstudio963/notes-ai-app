/**
 * Subscription / plan access (Free + Standard).
 * All Standard paths (trial, coins, Stripe) share one grant/revoke model and {@link hasStandardAccess}.
 */

const { COIN_CAP, TRIAL_DURATION_MS, STANDARD_MONTHLY_DURATION_MS } = require("../coins/coinConstants");

const STANDARD_COIN_DURATION_MS = STANDARD_MONTHLY_DURATION_MS;

const PLAN_ORDER = { free: 0, standard: 1 };

/** Legacy alias — monthly coin unlock duration. */
const STRIPE_STANDARD_DURATION_MS = STANDARD_MONTHLY_DURATION_MS;

const STANDARD_SOURCES = ["trial", "coins", "stripe"];

const REVOKE_STANDARD_SET = {
  plan: "free",
  subscriptionPlan: "free",
  membershipRole: "free",
  isPremium: false,
  standardSource: null,
  premiumExpires: null,
  premiumStartedAt: null,
  trialEndsAt: null,
  standardCoinExpiresAt: null
};

function normalizePlanToken(value) {
  const v = value != null ? String(value).toLowerCase() : "";
  if (v === "premium") return "standard";
  if (v === "standard" || v === "free") return v;
  return "free";
}

function tierFromRank(r) {
  if (r >= 1) return "standard";
  return "free";
}

function planRank(value) {
  return PLAN_ORDER[normalizePlanToken(value)] ?? 0;
}

function clampCoinBalancePreview(n) {
  const x = Math.floor(Number(n) || 0);
  return Math.min(COIN_CAP, Math.max(0, x));
}

/**
 * Canonical expiry for Standard access (premiumExpires is source of truth; legacy fields as fallback).
 * @param {object | null | undefined} user
 * @returns {Date | null}
 */
function resolveStandardExpiresAt(user) {
  if (!user) return null;
  if (user.premiumExpires) {
    const t = new Date(user.premiumExpires).getTime();
    if (Number.isFinite(t)) return new Date(t);
  }
  if (user.trialEndsAt) {
    const t = new Date(user.trialEndsAt).getTime();
    if (Number.isFinite(t)) return new Date(t);
  }
  if (user.standardCoinExpiresAt) {
    const t = new Date(user.standardCoinExpiresAt).getTime();
    if (Number.isFinite(t)) return new Date(t);
  }
  return null;
}

function inferStandardSource(user) {
  if (!user) return null;
  const src = user.standardSource ? String(user.standardSource).toLowerCase() : "";
  if (STANDARD_SOURCES.includes(src)) return src;
  if (user.trialEndsAt) return "trial";
  if (user.standardCoinExpiresAt) return "coins";
  if (user.isPremium || user.stripeSubscriptionId) return "stripe";
  return null;
}

/**
 * Single access gate for Web Chat, Scan Cam, exports, chat reminders, etc.
 * @param {object | null | undefined} user
 * @param {number} [nowMs]
 */
function hasStandardAccess(user, nowMs = Date.now()) {
  if (!user) return false;
  const exp = resolveStandardExpiresAt(user);
  if (exp) return exp.getTime() > nowMs;
  return false;
}

/** @deprecated Use {@link hasStandardAccess}. */
function hasStandardTierAccess(user) {
  return hasStandardAccess(user);
}

/** @deprecated Legacy name — same as {@link hasStandardAccess}. */
function hasActivePremium(user) {
  return hasStandardAccess(user);
}

function hasScanCamAccess(user) {
  return hasStandardAccess(user);
}

/**
 * Effective product plan for API/UI.
 * @returns {"free"|"standard"}
 */
function getUserPlan(user) {
  return hasStandardAccess(user) ? "standard" : "free";
}

function getStoredProductTier(user) {
  if (!user) return "free";
  return normalizePlanToken(user.plan || user.subscriptionPlan || user.membershipRole);
}

/**
 * @returns {"trial"|"free"|"standard"}
 */
function getUserLifecycle(user) {
  if (!hasStandardAccess(user)) return "free";
  const src = inferStandardSource(user);
  if (src === "trial") return "trial";
  return "standard";
}

/**
 * @returns {"free"|"standard_trial"|"standard_monthly"|"standard_yearly"}
 */
function getStandardPlanKind(user) {
  if (!hasStandardAccess(user)) return "free";
  const src = inferStandardSource(user);
  if (src === "trial") return "standard_trial";
  const yearly = user && String(user.billingCycle || "").toLowerCase() === "yearly";
  return yearly ? "standard_yearly" : "standard_monthly";
}

function getSubscriptionPlan(user) {
  return getUserPlan(user);
}

/**
 * @returns {"free"|"standard_trial"|"standard_monthly"|"standard_yearly"}
 */
function getStandardPlanKind(user) {
  if (!hasStandardAccess(user)) return "free";
  const src = inferStandardSource(user);
  if (src === "trial") return "standard_trial";
  const yearly = user && String(user.billingCycle || "").toLowerCase() === "yearly";
  return yearly ? "standard_yearly" : "standard_monthly";
}

function buildStandardStatusFields(user) {
  const active = hasStandardAccess(user);
  const exp = resolveStandardExpiresAt(user);
  const source = active ? inferStandardSource(user) : null;
  return {
    plan: active ? "standard" : "free",
    standardActive: active,
    standardExpiresAt: exp ? exp.toISOString() : null,
    standardSource: source
  };
}

/**
 * @returns {{ tier: "free" | "standard"; lifecycle: string; standardActive: boolean; standardExpiresAt: string | null; standardSource: string | null; ... }}
 */
function getPremiumStatusPayload(user) {
  const fields = buildStandardStatusFields(user);
  const tier = fields.plan;
  const lifecycle = getUserLifecycle(user);
  const standardFeatures = fields.standardActive;

  return {
    tier,
    lifecycle,
    plan: tier,
    planKind: getStandardPlanKind(user),
    billingCycle: user && user.billingCycle === "yearly" ? "yearly" : "monthly",
    standardActive: fields.standardActive,
    standardExpiresAt: fields.standardExpiresAt,
    standardSource: fields.standardSource,
    isPremium: false,
    premiumExpiresAt: fields.standardExpiresAt,
    trialEndsAt: user && user.trialEndsAt ? new Date(user.trialEndsAt).toISOString() : null,
    standardCoinExpiresAt:
      user && user.standardCoinExpiresAt ? new Date(user.standardCoinExpiresAt).toISOString() : null,
    coinBalance: clampCoinBalancePreview(user && user.coins),
    referralCode:
      user && user.referralCode != null && String(user.referralCode).trim()
        ? String(user.referralCode).trim()
        : user && user.inviteCode != null && String(user.inviteCode).trim()
          ? String(user.inviteCode).trim()
          : "",
    capabilities: {
      webNotifications: true,
      scanCam: standardFeatures,
      webChat: standardFeatures,
      pdfExport: standardFeatures
    }
  };
}

/**
 * Grant Standard for trial, coins, or Stripe.
 * @param {import("mongoose").Model} User
 * @param {string|import("mongoose").Types.ObjectId} userId
 * @param {{ source: "trial"|"coins"|"stripe"; expiresAt?: Date; durationMs?: number; startedAt?: Date; billingCycle?: "monthly"|"yearly"; billingCustomerId?: string; stripeSubscriptionId?: string }} options
 */
async function grantStandardAccess(User, userId, options = {}) {
  const source = String(options.source || "").toLowerCase();
  if (!STANDARD_SOURCES.includes(source)) {
    throw new Error("Invalid Standard source");
  }

  const startedAt = options.startedAt instanceof Date ? options.startedAt : new Date();
  const nowMs = startedAt.getTime();

  let expiresAt = options.expiresAt instanceof Date ? options.expiresAt : null;
  if (!expiresAt && options.durationMs) {
    expiresAt = new Date(nowMs + Number(options.durationMs));
  }
  if (!expiresAt || Number.isNaN(expiresAt.getTime())) {
    throw new Error("Standard grant requires expiresAt or durationMs");
  }

  const set = {
    plan: "standard",
    subscriptionPlan: "standard",
    membershipRole: "standard",
    isPremium: true,
    standardSource: source,
    premiumExpires: expiresAt,
    premiumStartedAt: startedAt,
    billingCycle: options.billingCycle === "yearly" ? "yearly" : "monthly"
  };

  if (source === "trial") {
    set.trialEndsAt = expiresAt;
    set.standardCoinExpiresAt = null;
  } else if (source === "coins") {
    set.standardCoinExpiresAt = expiresAt;
    set.trialEndsAt = null;
  } else {
    set.trialEndsAt = null;
    set.standardCoinExpiresAt = null;
  }

  if (options.billingCustomerId) {
    set.billingCustomerId = String(options.billingCustomerId);
  }
  if (options.stripeSubscriptionId) {
    set.stripeSubscriptionId = String(options.stripeSubscriptionId);
  }

  return User.findByIdAndUpdate(userId, { $set: set }, { new: true });
}

/**
 * New-account trial — 14 days, same access as paid Standard.
 */
async function grantNewUserTrial(User, userId) {
  return grantStandardAccess(User, userId, {
    source: "trial",
    durationMs: TRIAL_DURATION_MS
  });
}

/**
 * Repair signup gaps: grant the one-time 14-day trial if the account is still
 * inside the trial window and never received any Standard grant before.
 * @returns {Promise<{ granted: boolean; user: object | null }>}
 */
async function ensureEligibleNewUserTrial(User, userId, nowMs = Date.now()) {
  if (!User || !userId) return { granted: false, user: null };
  let user = await User.findById(userId).lean();
  if (!user) return { granted: false, user: null };
  if (hasStandardAccess(user, nowMs)) return { granted: false, user };

  const createdMs = user.createdAt ? new Date(user.createdAt).getTime() : NaN;
  if (!Number.isFinite(createdMs)) return { granted: false, user };
  const ageMs = nowMs - createdMs;
  if (ageMs < 0 || ageMs > TRIAL_DURATION_MS) {
    return { granted: false, user };
  }

  const src = user.standardSource ? String(user.standardSource).toLowerCase() : "";
  if (src === "stripe" || src === "coins" || user.stripeSubscriptionId) {
    return { granted: false, user };
  }

  const pastTrialEnd =
    user.trialEndsAt && new Date(user.trialEndsAt).getTime() <= nowMs;
  if (pastTrialEnd && src === "trial") {
    return { granted: false, user };
  }

  await grantNewUserTrial(User, userId);
  user = await User.findById(userId).lean();
  return { granted: true, user };
}

async function revokeStandardAccess(User, userId) {
  return User.findByIdAndUpdate(userId, { $set: { ...REVOKE_STANDARD_SET } }, { new: true });
}

/** @deprecated Use {@link revokeStandardAccess}. */
async function revokePremium(User, userId) {
  return revokeStandardAccess(User, userId);
}

/**
 * If Standard access has expired, revert user to Free.
 * @returns {Promise<boolean>} true if document was updated
 */
async function syncExpiredStandardAccess(User, userId) {
  if (!User || !userId) return false;
  const user = await User.findById(userId).lean();
  if (!user) return false;
  if (hasStandardAccess(user)) return false;

  const exp = resolveStandardExpiresAt(user);
  const stored = getStoredProductTier(user);
  const hadStandard =
    stored === "standard" ||
    Boolean(exp) ||
    Boolean(user.trialEndsAt) ||
    Boolean(user.standardCoinExpiresAt) ||
    user.isPremium === true;

  if (!hadStandard) return false;

  const r = await User.updateOne({ _id: userId }, { $set: { ...REVOKE_STANDARD_SET } }).exec();
  return Boolean(r && r.modifiedCount);
}

/** @deprecated Alias for {@link syncExpiredStandardAccess}. */
async function syncExpiredPremiumDocument(User, userId) {
  return syncExpiredStandardAccess(User, userId);
}

/**
 * Hourly-style sweep: revert all users whose Standard expiry is in the past.
 */
async function syncAllExpiredStandardAccess(User) {
  const now = new Date();
  const r = await User.updateMany(
    {
      $or: [
        { premiumExpires: { $ne: null, $lte: now } },
        { trialEndsAt: { $ne: null, $lte: now } },
        { standardCoinExpiresAt: { $ne: null, $lte: now } }
      ]
    },
    { $set: { ...REVOKE_STANDARD_SET } }
  ).exec();
  return r && r.modifiedCount ? r.modifiedCount : 0;
}

async function grantPremium(User, userId, options = {}) {
  const startedAt = options.startedAt instanceof Date ? options.startedAt : new Date();
  let expiresAt = options.expiresAt instanceof Date ? options.expiresAt : null;
  if (!expiresAt && options.durationMs) {
    expiresAt = new Date(startedAt.getTime() + Number(options.durationMs));
  }
  if (!expiresAt) {
    const err = new Error("Standard grant requires expiresAt or durationMs");
    throw err;
  }
  return grantStandardAccess(User, userId, {
    source: options.source || "stripe",
    expiresAt,
    startedAt,
    billingCycle: options.billingCycle,
    billingCustomerId: options.billingCustomerId,
    stripeSubscriptionId: options.stripeSubscriptionId
  });
}

async function adminGrantPremiumMonths(User, userId, months) {
  const m = Math.floor(Number(months) || 0);
  if (!Number.isFinite(m) || m <= 0 || m > 120) {
    throw new Error("Invalid months");
  }
  const u = await User.findById(userId).select("premiumExpires").lean();
  if (!u) throw new Error("User not found");

  const nowMs = Date.now();
  let baseMs = nowMs;
  const existing = resolveStandardExpiresAt(u);
  if (existing && existing.getTime() > nowMs) {
    baseMs = existing.getTime();
  }
  const d = new Date(baseMs);
  d.setUTCMonth(d.getUTCMonth() + m);
  return grantPremium(User, userId, { expiresAt: d, source: "coins" });
}

async function adminGrantPremiumLifetime(User, userId) {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() + 10);
  return grantPremium(User, userId, { expiresAt: d, source: "coins" });
}

/**
 * Admin: set product plan. Standard requires an active grant (use grant endpoints for expiry).
 */
async function applyProductPlan(User, userId, plan, options = {}) {
  const normalized = normalizePlanToken(plan);
  if (!["free", "standard"].includes(normalized)) {
    throw new Error("Invalid plan");
  }
  if (normalized === "free") {
    return revokeStandardAccess(User, userId);
  }
  return grantStandardAccess(User, userId, {
    source: options.source || "coins",
    expiresAt: options.expiresAt,
    durationMs: options.durationMs || STANDARD_COIN_DURATION_MS,
    startedAt: options.startedAt,
    billingCycle: options.billingCycle
  });
}

const LEAN_USER_SUBSCRIPTION_TIER_FIELDS =
  "isPremium premiumExpires plan subscriptionPlan membershipRole standardSource trialEndsAt standardCoinExpiresAt";

module.exports = {
  LEAN_USER_SUBSCRIPTION_TIER_FIELDS,
  TRIAL_DURATION_MS,
  STRIPE_STANDARD_DURATION_MS,
  getUserPlan,
  getUserLifecycle,
  getStandardPlanKind,
  getStoredProductTier,
  hasStandardAccess,
  hasStandardTierAccess,
  hasActivePremium,
  getSubscriptionPlan,
  hasScanCamAccess,
  getPremiumStatusPayload,
  resolveStandardExpiresAt,
  inferStandardSource,
  grantStandardAccess,
  grantNewUserTrial,
  ensureEligibleNewUserTrial,
  revokeStandardAccess,
  grantPremium,
  revokePremium,
  applyProductPlan,
  adminGrantPremiumMonths,
  adminGrantPremiumLifetime,
  syncExpiredStandardAccess,
  syncExpiredPremiumDocument,
  syncAllExpiredStandardAccess
};
