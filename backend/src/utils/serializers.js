const { getPremiumStatusPayload, getUserPlan } = require("../features/premium/subscriptionService");

function sanitizeDisplayEmail(primary, fallback) {
  const a = String(primary || "").trim();
  const b = String(fallback || "").trim();
  const synthetic = /@users\.notesai\.invalid$/i;
  if (a && !synthetic.test(a)) return a;
  if (b && !synthetic.test(b)) return b;
  return a || b || "";
}

function publicUser(user) {
  const premium = getPremiumStatusPayload(user);
  const plan = getUserPlan(user);
  const displayEmail = sanitizeDisplayEmail(user.email, user.emailOrPhone);
  return {
    id: user._id,
    firstName: user.firstName,
    lastName: user.lastName,
    username: user.username,
    email: displayEmail,
    emailOrPhone: user.emailOrPhone,
    emailVerified: Boolean(user.emailVerified),
    role: user.role || "user",
    plan,
    membershipRole: plan,
    theme: user.theme || "classic",
    language: user.language || "en",
    isPremium: premium.isPremium,
    premiumExpiresAt: premium.premiumExpiresAt,
    standardActive: premium.standardActive,
    standardExpiresAt: premium.standardExpiresAt,
    standardSource: premium.standardSource,
    tier: premium.tier,
    lifecycle: premium.lifecycle,
    trialEndsAt: premium.trialEndsAt,
    standardCoinExpiresAt: premium.standardCoinExpiresAt,
    coinBalance: premium.coinBalance,
    referralCode: premium.referralCode || "",
    inviteCode: premium.referralCode || "",
    invitedBy: user.invitedBy || user.referredByUserId || null,
    referralRewarded: Boolean(user.referralRewarded || user.inviteBonusCreditedAt),
    subscriptionPlan: plan,
    capabilities: premium.capabilities,
    googlePicture: user.googlePicture || "",
    provider: user.provider || "local",
    hasLocalPassword: Boolean(user.password),
    needsUsername: Boolean(user.needsUsername),
    usernameLastChangedAt: user.usernameLastChangedAt
      ? new Date(user.usernameLastChangedAt).toISOString()
      : null,
    // Legacy docs without this field must not suddenly see onboarding.
    hasSeenTutorial: user.hasSeenTutorial !== false
  };
}

module.exports = { publicUser };
