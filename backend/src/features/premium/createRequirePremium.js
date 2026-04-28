const { hasActivePremium } = require("./subscriptionService");

const PREMIUM_ERROR = "Premium subscription required for WhatsApp / SMS reminders.";
const PREMIUM_CODE = "PREMIUM_REQUIRED";

/**
 * Express middleware: blocks unless the authenticated user has active premium.
 * Use only on routes that are entirely premium (e.g. future dedicated SMS APIs).
 *
 * @param {{ User: import("mongoose").Model }} deps
 */
function createRequirePremium({ User }) {
  return async function requirePremium(req, res, next) {
    try {
      const user = await User.findById(req.userId).select(
        "isPremium premiumExpires plan subscriptionPlan membershipRole"
      );
      if (!user || !hasActivePremium(user)) {
        return res.status(403).json({
          error: PREMIUM_ERROR,
          code: PREMIUM_CODE
        });
      }
      next();
    } catch {
      res.status(500).json({ error: "Failed to verify subscription" });
    }
  };
}

module.exports = {
  createRequirePremium,
  PREMIUM_ERROR,
  PREMIUM_CODE
};
