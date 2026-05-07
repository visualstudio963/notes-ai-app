const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    firstName: { type: String, default: "" },
    lastName: { type: String, default: "" },
    username: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    // Legacy field kept for backwards compatibility with existing UI/admin consumers.
    emailOrPhone: { type: String, required: true, unique: true },
    /** Null for Google-only accounts (no local password). */
    password: { type: String, default: null },
    googleId: { type: String, default: null },
    /** Profile photo URL from Google OAuth (optional). */
    googlePicture: { type: String, default: "" },
    provider: { type: String, enum: ["local", "google"], default: "local" },
    deviceId: { type: String, default: "" },
    emailVerified: { type: Boolean, default: false },
    emailVerificationTokenHash: { type: String, default: null },
    emailVerificationExpiresAt: { type: Date, default: null },
    refreshToken: { type: String },
    theme: { type: String, default: "classic", enum: ["classic", "normal", "advanced"] },
    language: { type: String, default: "en" },
    isPremium: { type: Boolean, default: false },
    /**
     * Canonical product plan (free = default; standard / premium = upgrades).
     * Kept in sync with subscriptionPlan + membershipRole for legacy reads until fully migrated.
     */
    plan: { type: String, enum: ["free", "standard", "premium"], default: "free" },
    /** @deprecated Use plan — still written in sync for older code paths */
    subscriptionPlan: {
      type: String,
      enum: ["free", "standard", "premium"],
      default: "free"
    },
    premiumExpires: { type: Date, default: null },
    /** UTC timestamp when premium access started; used to anchor monthly OpenAI usage resets. */
    premiumStartedAt: { type: Date, default: null },
    /** Billing cadence selected at checkout (monthly/yearly). */
    billingCycle: { type: String, enum: ["monthly", "yearly"], default: "monthly" },
    /** Reserved for Stripe Customer ID or similar when payments are wired in */
    billingCustomerId: { type: String, default: null },
    /** Latest Stripe subscription id used for paid plan lifecycle tracking */
    stripeSubscriptionId: { type: String, default: null },
    /** @deprecated Use plan — still written in sync for older code paths */
    membershipRole: { type: String, enum: ["free", "standard", "premium"], default: "free" },
    /** Staff: user = normal customer; admin / moderator / support = admin panel login */
    role: { type: String, enum: ["user", "admin", "moderator", "support"], default: "user" },
    lastActive: { type: Date, default: null },
    /** UTC year-month (YYYY-MM) for monthly OpenAI Web Chat usage counter */
    webChatOpenAiPeriod: { type: String, default: "" },
    webChatOpenAiUsed: { type: Number, default: 0 },
    /**
     * True for new Google sign-ups until the user picks a public username in Settings
     * (a provisional unique username is still stored for schema/legacy reasons).
     */
    needsUsername: { type: Boolean, default: false },
    /** Last time username was changed (first pick from provisional also sets this); enforces cooldown in settings */
    usernameLastChangedAt: { type: Date, default: null },
    /** Trial: new accounts get STANDARD-level features until this UTC time */
    trialEndsAt: { type: Date, default: null },
    /** STANDARD unlocked with coins until this UTC time */
    standardCoinExpiresAt: { type: Date, default: null },
    /** Gamification balance (hard cap enforced in app logic) */
    coins: { type: Number, default: 0 },
    dailyLoginUtcDate: { type: String, default: "" },
    /** Next streak reward day in the 7-day cycle (1–7) */
    loginStreakNextIndex: { type: Number, default: 1, min: 1, max: 7 },
    videoRewardUtcDate: { type: String, default: "" },
    videoRewardCount: { type: Number, default: 0 },
    referralCode: { type: String, default: "", trim: true },
    /** Alias for referralCode (kept for clearer API semantics in invite links). */
    inviteCode: { type: String, default: "", trim: true },
    referredByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    /** Alias for referredByUserId. */
    invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    inviteBonusCreditedAt: { type: Date, default: null },
    /** True once invite reward has been processed (idempotency guard). */
    referralRewarded: { type: Boolean, default: false },
    inviteFriendMonthYm: { type: String, default: "" },
    inviteFriendMonthCount: { type: Number, default: 0 },
    /** False = show first-time onboarding; missing on legacy users is treated as “seen” in serializers */
    hasSeenTutorial: { type: Boolean, default: false }
  },
  { timestamps: true }
);

/**
 * Keep email + emailOrPhone in sync (required by schema). Legacy imports or rare writes
 * can omit `email`; any full document save (e.g. coins daily claim) would otherwise fail
 * with "Path `email` is required."
 * Must match LOCAL_ACCOUNT_EMAIL_DOMAIN in auth.routes.js for synthetic local accounts.
 */
const SYNTHETIC_EMAIL_DOMAIN = "users.notesai.invalid";

userSchema.pre("validate", function syncLegacyEmailOrPhone(next) {
  try {
    if (typeof this.email === "string") {
      this.email = this.email.trim().toLowerCase();
    }

    const eop =
      typeof this.emailOrPhone === "string" ? this.emailOrPhone.trim().toLowerCase() : "";

    if ((!this.email || this.email === "") && eop.includes("@")) {
      this.email = eop;
    }

    let u = typeof this.username === "string" ? this.username.trim().toLowerCase() : "";
    /* Strip characters invalid in the local-part first segment — keeps synthetic email sane */
    u = u.replace(/[^a-z0-9_]/g, "");
    if ((!this.email || this.email === "") && u.length >= 1) {
      this.email = `${u}@${SYNTHETIC_EMAIL_DOMAIN}`;
    }

    /* Absolute fallback: authenticated docs always have _id (legacy rows missing email/username) */
    if ((!this.email || this.email === "") && this._id && mongoose.Types.ObjectId.isValid(this._id)) {
      this.email = `u${String(this._id)}@${SYNTHETIC_EMAIL_DOMAIN}`;
    }

    if ((!this.emailOrPhone || String(this.emailOrPhone).trim() === "") && this.email) {
      this.emailOrPhone = this.email;
    }

    const codeA = typeof this.referralCode === "string" ? this.referralCode.trim().toUpperCase() : "";
    const codeB = typeof this.inviteCode === "string" ? this.inviteCode.trim().toUpperCase() : "";
    if (codeA && !codeB) this.inviteCode = codeA;
    if (codeB && !codeA) this.referralCode = codeB;
    if (codeA && codeB && codeA !== codeB) this.inviteCode = codeA;

    if (this.referredByUserId && !this.invitedBy) this.invitedBy = this.referredByUserId;
    if (this.invitedBy && !this.referredByUserId) this.referredByUserId = this.invitedBy;

    next();
  } catch (e) {
    next(e);
  }
});

userSchema.index(
  { username: 1 },
  {
    unique: true
  }
);

userSchema.index(
  { deviceId: 1 },
  {
    unique: true,
    partialFilterExpression: { deviceId: { $type: "string", $gt: "" } }
  }
);

userSchema.index(
  { googleId: 1 },
  {
    unique: true,
    partialFilterExpression: { googleId: { $exists: true, $type: "string", $gt: "" } }
  }
);

userSchema.index(
  { referralCode: 1 },
  {
    unique: true,
    partialFilterExpression: { referralCode: { $exists: true, $type: "string", $gt: "" } }
  }
);

userSchema.index(
  { inviteCode: 1 },
  {
    unique: true,
    partialFilterExpression: { inviteCode: { $exists: true, $type: "string", $gt: "" } }
  }
);

module.exports = mongoose.model("User", userSchema);
