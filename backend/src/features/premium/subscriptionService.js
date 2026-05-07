/**

 * Subscription / premium access (Twilio WhatsApp & SMS reminder channels).

 * Payment providers (e.g. Stripe) can call {@link grantPremium} from webhooks later.

 *

 * Canonical product tier is {@link getUserPlan} (single effective plan: free | standard | premium).

 * Legacy fields `plan`, `subscriptionPlan`, `membershipRole`, and `isPremium` are merged consistently.

 */



/** Premium Web Chat: max OpenAI completions per monthly billing window (UTC). */

const OPENAI_WEB_CHAT_MONTHLY_LIMIT = 130;

const { COIN_CAP } = require("../coins/coinConstants");



const PLAN_ORDER = { free: 0, standard: 1, premium: 2 };



function normalizePlanToken(value) {

  const v = value != null ? String(value).toLowerCase() : "";

  if (v === "standard" || v === "premium" || v === "free") return v;

  return "free";

}



function tierFromRank(r) {

  if (r >= 2) return "premium";

  if (r >= 1) return "standard";

  return "free";

}



function planRank(value) {

  return PLAN_ORDER[normalizePlanToken(value)] ?? 0;

}



/**

 * Max tier stored on the user document (ignores active `isPremium` billing boost).

 * @param {{ plan?: string; subscriptionPlan?: string; membershipRole?: string } | null | undefined} user

 * @returns {"free"|"standard"|"premium"}

 */

function getStoredProductTier(user) {

  if (!user) return "free";

  let r = 0;

  for (const key of ["plan", "subscriptionPlan", "membershipRole"]) {

    r = Math.max(r, planRank(user[key]));

  }

  return tierFromRank(r);

}

function clampCoinBalancePreview(n) {
  const x = Math.floor(Number(n) || 0);
  return Math.min(COIN_CAP, Math.max(0, x));
}

function trialActive(user, nowMs = Date.now()) {
  if (!user || !user.trialEndsAt) return false;
  const t = new Date(user.trialEndsAt).getTime();
  return Number.isFinite(t) && t > nowMs;
}

function coinStandardActive(user, nowMs = Date.now()) {
  if (!user || !user.standardCoinExpiresAt) return false;
  const t = new Date(user.standardCoinExpiresAt).getTime();
  return Number.isFinite(t) && t > nowMs;
}

function boostStandardFromPromos(user, nowMs = Date.now()) {
  return trialActive(user, nowMs) || coinStandardActive(user, nowMs);
}

/**

 * Effective product plan (admin + app + billing), merging legacy fields.

 * @param {{ plan?: string; subscriptionPlan?: string; membershipRole?: string; isPremium?: boolean; premiumExpires?: Date | null; trialEndsAt?: Date | null; standardCoinExpiresAt?: Date | null } | null | undefined} user

 * @returns {"free"|"standard"|"premium"}

 */

function getUserPlan(user) {
  if (!user) return "free";

  const nowMs = Date.now();

  /** Only real boolean true counts — avoids truthy garbage from imports (e.g. string "false"). */
  const premiumBillingActive =
    user.isPremium === true &&
    (user.premiumExpires == null || new Date(user.premiumExpires).getTime() > nowMs);

  const stored = getStoredProductTier(user);

  /**
   * Stored `plan` may still say "premium" after a time-limited comp expires; do not treat that as
   * active premium unless {@link premiumBillingActive}. Stripe subscriptions use `isPremium` with
   * `premiumExpires` null while active.
   */
  let r = planRank("free");
  if (stored === "standard") {
    r = planRank("standard");
  } else if (stored === "free") {
    r = planRank("free");
  } else if (stored === "premium") {
    r = premiumBillingActive ? planRank("premium") : planRank("free");
  }

  if (premiumBillingActive) {
    r = Math.max(r, planRank("premium"));
  }

  if (boostStandardFromPromos(user, nowMs)) {
    r = Math.max(r, planRank("standard"));
  }

  return tierFromRank(r);
}

/**
 * Exclusive UI/account state — not the same as {@link getUserPlan} tier (trial still maps to Standard features).
 * @returns {"trial"|"free"|"standard"|"premium"}
 */
function getUserLifecycle(user) {

  if (!user) return "free";

  const nowMs = Date.now();

  const tier = getUserPlan(user);

  const stored = getStoredProductTier(user);

  const trialOn = trialActive(user, nowMs);

  const coinOn = coinStandardActive(user, nowMs);

  if (tier === "premium") return "premium";

  if (trialOn && stored === "free" && !coinOn && tier === "standard") return "trial";

  if (tier === "standard") return "standard";

  return "free";

}



function utcYearMonth(d = new Date()) {

  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

}

function daysInUtcMonth(year, monthIndex) {

  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();

}

function resolveOpenAiAnchorDay(user, now = new Date()) {

  const src = user && (user.premiumStartedAt || user.createdAt);

  const day = src ? new Date(src).getUTCDate() : now.getUTCDate();

  if (!Number.isFinite(day)) return 1;

  return Math.min(31, Math.max(1, day));

}

function computeMonthlyCycleStartUtc(anchorDay, now = new Date()) {

  const year = now.getUTCFullYear();

  const month = now.getUTCMonth();

  const thisMonthDay = Math.min(anchorDay, daysInUtcMonth(year, month));

  const thisMonthStart = new Date(Date.UTC(year, month, thisMonthDay, 0, 0, 0, 0));

  if (now.getTime() >= thisMonthStart.getTime()) return thisMonthStart;

  const prevMonthDate = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));

  const prevYear = prevMonthDate.getUTCFullYear();

  const prevMonth = prevMonthDate.getUTCMonth();

  const prevDay = Math.min(anchorDay, daysInUtcMonth(prevYear, prevMonth));

  return new Date(Date.UTC(prevYear, prevMonth, prevDay, 0, 0, 0, 0));

}

function computeOpenAiUsagePeriod(user, now = new Date()) {

  const anchorDay = resolveOpenAiAnchorDay(user, now);

  const cycleStart = computeMonthlyCycleStartUtc(anchorDay, now);

  return cycleStart.toISOString().slice(0, 10);

}



/**

 * @param {{ webChatOpenAiPeriod?: string; webChatOpenAiUsed?: number } | null | undefined} user

 */

function computeOpenAiWebChatUsage(user) {

  const period = computeOpenAiUsagePeriod(user);

  const storedPeriod = user && user.webChatOpenAiPeriod ? String(user.webChatOpenAiPeriod) : "";

  const used = storedPeriod === period ? Number(user.webChatOpenAiUsed || 0) : 0;

  return {

    monthlyLimit: OPENAI_WEB_CHAT_MONTHLY_LIMIT,

    used,

    remaining: Math.max(0, OPENAI_WEB_CHAT_MONTHLY_LIMIT - used),

    period

  };

}



/**

 * OpenAI-backed Web Chat is Premium-only (Standard uses local bot only).

 * @param {{ plan?: string; subscriptionPlan?: string; membershipRole?: string; isPremium?: boolean; premiumExpires?: Date | null } | null | undefined} user

 */

function hasWebChatOpenAiAccess(user) {

  return hasActivePremium(user);

}



/**

 * @param {{ plan?: string; subscriptionPlan?: string; membershipRole?: string; isPremium?: boolean; premiumExpires?: Date | null; webChatOpenAiPeriod?: string; webChatOpenAiUsed?: number } | null | undefined} user

 */

function getOpenAiWebChatUsageState(user) {

  if (!hasActivePremium(user)) return null;

  return computeOpenAiWebChatUsage(user);

}



/**

 * Premium channel access (WhatsApp / SMS reminders, OpenAI web chat, etc.).

 * @param {{ plan?: string; subscriptionPlan?: string; membershipRole?: string; isPremium?: boolean; premiumExpires?: Date | null } | null | undefined} user

 * @returns {boolean}

 */

function hasActivePremium(user) {

  return getUserPlan(user) === "premium";

}



/**

 * @param {{ plan?: string; subscriptionPlan?: string; membershipRole?: string; isPremium?: boolean; premiumExpires?: Date | null }} user

 * @returns {"free"|"standard"|"premium"}

 */

function getSubscriptionPlan(user) {

  return getUserPlan(user);

}



/**

 * Standard-tier product features (Web Chat, Scan Cam, PDF tools, chat-sourced web reminders).

 * @param {{ plan?: string; subscriptionPlan?: string; membershipRole?: string; isPremium?: boolean; premiumExpires?: Date | null }} user

 */

function hasStandardTierAccess(user) {

  const p = getUserPlan(user);

  return p === "standard" || p === "premium";

}



/** Alias for {@link hasStandardTierAccess} — Scan Cam uses the Standard tier gate. */

function hasScanCamAccess(user) {

  return hasStandardTierAccess(user);

}



/**

 * @param {{ plan?: string; subscriptionPlan?: string; membershipRole?: string; isPremium?: boolean; premiumExpires?: Date | null; webChatOpenAiPeriod?: string; webChatOpenAiUsed?: number }} user

 * @returns {{ tier: "free" | "standard" | "premium"; isPremium: boolean; premiumExpiresAt: string | null; capabilities: { webNotifications: boolean; whatsAppSmsReminders: boolean; scanCam: boolean; webChat: boolean; pdfExport: boolean } }}

 */

function getPremiumStatusPayload(user) {

  const tier = getUserPlan(user);

  const premium = tier === "premium";

  const standardFeatures = hasStandardTierAccess(user);

  const lifecycle = getUserLifecycle(user);



  return {

    tier,

    lifecycle,

    isPremium: premium,

    premiumExpiresAt: user && user.premiumExpires ? new Date(user.premiumExpires).toISOString() : null,

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

      whatsAppSmsReminders: premium,

      scanCam: standardFeatures,

      webChat: standardFeatures,

      /** Premium only: OpenAI replies in Web Chat (monthly cap). */

      webChatOpenAI: hasWebChatOpenAiAccess(user),

      /** Reserved for future PDF export routes — same gate as Web Chat / Scan Cam. */

      pdfExport: standardFeatures

    },

    openAiWebChat: getOpenAiWebChatUsageState(user)

  };

}



/**

 * @param {import("mongoose").Model} User

 * @param {string} userId

 * @param {{ expiresAt?: Date | null; billingCustomerId?: string | null }} [options]

 */

async function grantPremium(User, userId, options = {}) {

  const { expiresAt = null, billingCustomerId, startedAt = new Date(), billingCycle = "monthly" } = options;

  const updates = {

    isPremium: true,

    plan: "premium",

    subscriptionPlan: "premium",

    membershipRole: "premium",

    premiumStartedAt: startedAt,

    billingCycle: billingCycle === "yearly" ? "yearly" : "monthly"

  };

  if (expiresAt !== undefined) {

    updates.premiumExpires = expiresAt;

  }

  if (billingCustomerId !== undefined) {

    updates.billingCustomerId = billingCustomerId || null;

  }

  return User.findByIdAndUpdate(userId, { $set: updates }, { new: true });

}



/**

 * Clears billing premium. If stored tier fields were all premium (e.g. after {@link grantPremium}),

 * resets them to free so the user does not remain premium from drift. If stored tier was standard,

 * keeps standard and only clears `isPremium`.

 * @param {import("mongoose").Model} User

 * @param {string} userId

 */

async function revokePremium(User, userId) {

  const u = await User.findById(userId).select("plan subscriptionPlan membershipRole").lean();

  const stored = getStoredProductTier(u);

  const updates = { isPremium: false, premiumExpires: null };

  if (stored === "premium") {

    updates.plan = "free";

    updates.subscriptionPlan = "free";

    updates.membershipRole = "free";

  }

  return User.findByIdAndUpdate(userId, { $set: updates }, { new: true });

}

/**
 * Extend Premium from current expiry (or now) by N calendar months — admin / moderator comps.
 * @param {import("mongoose").Model} User
 * @param {string} userId
 * @param {number} months 1–120
 */
async function adminGrantPremiumMonths(User, userId, months) {
  const m = Math.floor(Number(months) || 0);
  if (!Number.isFinite(m) || m <= 0 || m > 120) {
    throw new Error("Invalid months");
  }
  const u = await User.findById(userId).select("premiumExpires isPremium").lean();
  if (!u) throw new Error("User not found");

  const nowMs = Date.now();
  let baseMs = nowMs;
  if (u.isPremium === true && u.premiumExpires) {
    const t = new Date(u.premiumExpires).getTime();
    if (Number.isFinite(t) && t > nowMs) baseMs = t;
  }
  const d = new Date(baseMs);
  d.setUTCMonth(d.getUTCMonth() + m);
  return grantPremium(User, userId, { expiresAt: d });
}

/**
 * Lifetime Premium (no expiry) — admin / moderator comps.
 * @param {import("mongoose").Model} User
 * @param {string} userId
 */
async function adminGrantPremiumLifetime(User, userId) {
  return grantPremium(User, userId, { expiresAt: null });
}

/**

 * Admin / product: set canonical plan and keep legacy fields in sync.

 * @param {import("mongoose").Model} User

 * @param {string} userId

 * @param {"free"|"standard"|"premium"} plan

 */

async function applyProductPlan(User, userId, plan, options = {}) {

  const allowed = ["free", "standard", "premium"];

  if (!allowed.includes(plan)) {

    throw new Error("Invalid plan");

  }

  const updates = {

    plan,

    subscriptionPlan: plan,

    membershipRole: plan

  };

  if (plan === "premium") {

    const startedAt = options.startedAt instanceof Date ? options.startedAt : new Date();

    updates.isPremium = true;

    updates.premiumExpires = null;

    updates.premiumStartedAt = startedAt;

    updates.billingCycle = options.billingCycle === "yearly" ? "yearly" : "monthly";

  } else {

    updates.isPremium = false;

    updates.premiumExpires = null;

    updates.premiumStartedAt = null;

    updates.billingCycle = "monthly";

  }

  return User.findByIdAndUpdate(userId, { $set: updates }, { new: true });

}



/**

 * Time-limited Premium (`premiumExpires` set) should roll the stored product tier back to Free

 * once the window ends. Stripe/lifetime Premium keeps `premiumExpires` null — not touched here.

 *

 * @param {import("mongoose").Model} User

 * @param {string} userId

 * @returns {Promise<boolean>} true if a document was updated

 */

async function syncExpiredPremiumDocument(User, userId) {

  if (!User || !userId) return false;

  const now = new Date();

  const r = await User.updateOne(

    {

      _id: userId,

      isPremium: true,

      premiumExpires: { $ne: null, $lte: now }

    },

    {

      $set: {

        isPremium: false,

        plan: "free",

        subscriptionPlan: "free",

        membershipRole: "free",

        premiumExpires: null,

        premiumStartedAt: null

      }

    }

  ).exec();

  return Boolean(r && r.modifiedCount);

}



module.exports = {

  getUserPlan,

  getUserLifecycle,

  getStoredProductTier,

  hasActivePremium,

  getSubscriptionPlan,

  hasStandardTierAccess,

  hasScanCamAccess,

  getPremiumStatusPayload,

  grantPremium,

  revokePremium,

  applyProductPlan,

  adminGrantPremiumMonths,

  adminGrantPremiumLifetime,

  syncExpiredPremiumDocument,

  OPENAI_WEB_CHAT_MONTHLY_LIMIT,

  utcYearMonth,

  computeOpenAiUsagePeriod,

  computeOpenAiWebChatUsage,

  hasWebChatOpenAiAccess,

  getOpenAiWebChatUsageState

};


