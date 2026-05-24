const express = require("express");
const {
  getPremiumStatusPayload,
  getSubscriptionPlan,
  getUserPlan,
  grantStandardAccess,
  syncExpiredPremiumDocument,
  ensureEligibleNewUserTrial
} = require("./subscriptionService");

/**
 * Premium status only — Standard is unlocked via trial (signup) or coins (see coins routes).
 *
 * @param {{
 *   User: import("mongoose").Model;
 *   authMiddleware: import("express").RequestHandler;
 *   premiumDevSecret?: string | null;
 * }} deps
 */
function createPremiumRouter({ User, authMiddleware, premiumDevSecret }) {
  const router = express.Router();

  router.get("/premium/status", authMiddleware, async (req, res) => {
    try {
      await ensureEligibleNewUserTrial(User, req.userId);
      await syncExpiredPremiumDocument(User, req.userId);
      const user = await User.findById(req.userId).select(
        "isPremium premiumExpires premiumStartedAt createdAt billingCycle billingCustomerId stripeSubscriptionId plan subscriptionPlan membershipRole standardSource coins trialEndsAt standardCoinExpiresAt referralCode"
      );
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      const status = getPremiumStatusPayload(user);
      res.json({
        ...status,
        plan: getUserPlan(user),
        subscriptionPlan: getSubscriptionPlan(user),
        billingCycle: user.billingCycle === "yearly" ? "yearly" : "monthly",
        billingReady: false,
        subscriptionStatus: null,
        cancelAtPeriodEnd: false,
        currentPeriodEnd: status.standardExpiresAt || null
      });
    } catch {
      res.status(500).json({ error: "Failed to load premium status" });
    }
  });

  /** Dev / manual activation — coins-equivalent grant for local testing only. */
  if (premiumDevSecret && String(premiumDevSecret).trim()) {
    router.post("/premium/activate-dev", authMiddleware, async (req, res) => {
      const { secret, days } = req.body || {};
      if (secret !== premiumDevSecret) {
        return res.status(403).json({ error: "Invalid activation secret" });
      }
      try {
        let durationMs = 30 * 24 * 60 * 60 * 1000;
        if (days != null && Number.isFinite(Number(days)) && Number(days) > 0) {
          durationMs = Number(days) * 24 * 60 * 60 * 1000;
        }
        const user = await grantStandardAccess(User, req.userId, {
          source: "coins",
          durationMs
        });
        if (!user) {
          return res.status(404).json({ error: "User not found" });
        }
        res.json({ success: true, user: getPremiumStatusPayload(user) });
      } catch {
        res.status(500).json({ error: "Activation failed" });
      }
    });
  }

  return router;
}

module.exports = { createPremiumRouter };
