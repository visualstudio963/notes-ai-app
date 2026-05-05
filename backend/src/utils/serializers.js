const { getPremiumStatusPayload, getUserPlan } = require("../features/premium/subscriptionService");

function publicUser(user) {
  const premium = getPremiumStatusPayload(user);
  const plan = getUserPlan(user);
  return {
    id: user._id,
    firstName: user.firstName,
    lastName: user.lastName,
    username: user.username,
    email: user.email || user.emailOrPhone || "",
    emailOrPhone: user.emailOrPhone,
    emailVerified: Boolean(user.emailVerified),
    role: user.role || "user",
    plan,
    membershipRole: plan,
    theme: user.theme || "classic",
    language: user.language || "en",
    isPremium: premium.isPremium,
    premiumExpiresAt: premium.premiumExpiresAt,
    tier: premium.tier,
    lifecycle: premium.lifecycle,
    trialEndsAt: premium.trialEndsAt,
    standardCoinExpiresAt: premium.standardCoinExpiresAt,
    coinBalance: premium.coinBalance,
    referralCode: premium.referralCode || "",
    subscriptionPlan: plan,
    capabilities: premium.capabilities,
    googlePicture: user.googlePicture || "",
    provider: user.provider || "local",
    hasLocalPassword: Boolean(user.password),
    needsUsername: Boolean(user.needsUsername),
    usernameLastChangedAt: user.usernameLastChangedAt
      ? new Date(user.usernameLastChangedAt).toISOString()
      : null
  };
}

module.exports = { publicUser };
