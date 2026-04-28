const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    firstName: { type: String, default: "" },
    lastName: { type: String, default: "" },
    username: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    // Legacy field kept for backwards compatibility with existing UI/admin consumers.
    emailOrPhone: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    phone: { type: String, default: "" },
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
    role: { type: String, enum: ["user", "admin"], default: "user" },
    lastActive: { type: Date, default: null },
    /** UTC year-month (YYYY-MM) for monthly OpenAI Web Chat usage counter */
    webChatOpenAiPeriod: { type: String, default: "" },
    webChatOpenAiUsed: { type: Number, default: 0 }
  },
  { timestamps: true }
);

userSchema.pre("validate", function syncLegacyEmailOrPhone(next) {
  if (typeof this.email === "string") {
    this.email = this.email.trim().toLowerCase();
  }
  if (!this.emailOrPhone && this.email) {
    this.emailOrPhone = this.email;
  }
  next();
});

userSchema.index(
  { phone: 1 },
  {
    unique: true,
    partialFilterExpression: { phone: { $type: "string", $gt: "" } }
  }
);

module.exports = mongoose.model("User", userSchema);
