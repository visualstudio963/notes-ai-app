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
    phone: user.phone,
    theme: user.theme || "classic",
    language: user.language || "en",
    isPremium: premium.isPremium,
    premiumExpiresAt: premium.premiumExpiresAt,
    tier: premium.tier,
    subscriptionPlan: plan,
    capabilities: premium.capabilities,
    googlePicture: user.googlePicture || "",
    provider: user.provider || "local",
    hasLocalPassword: Boolean(user.password)
  };
}

module.exports = { publicUser };
