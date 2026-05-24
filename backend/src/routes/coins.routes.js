const express = require("express");
const {
  bindReferralCode,
  claimDailyLogin,
  claimVideoReward,
  redeemStandardWithCoins,
  buildCoinsStatusPayload,
  enrichCoinsStatusWithInviteStats,
  ensureReferralCode,
  finalizeInviteBonus
} = require("../features/coins/coinService");
const { syncExpiredPremiumDocument, ensureEligibleNewUserTrial } = require("../features/premium/subscriptionService");

async function finalizePendingInviteRewards(User, userId) {
  let doc = await User.findById(userId);
  if (!doc) return null;
  doc = await ensureReferralCode(User, doc);
  await finalizeInviteBonus(User, doc);
  return User.findById(userId).lean();
}

function createCoinsRouter({ User, authMiddleware }) {
  const router = express.Router();

  router.get("/coins/status", authMiddleware, async (req, res) => {
    try {
      await ensureEligibleNewUserTrial(User, req.userId);
      await syncExpiredPremiumDocument(User, req.userId);
      let user = await User.findById(req.userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      user = await ensureReferralCode(User, user);
      await finalizeInviteBonus(User, user);

      /* Auto-claim daily streak on status load once per UTC day (no extra tap). */
      try {
        await claimDailyLogin(User, req.userId);
      } catch (err) {
        const code = err && err.code ? String(err.code) : "";
        if (code !== "DAILY_CLAIMED" && err.statusCode !== 409) {
          throw err;
        }
      }

      user = await User.findById(req.userId).lean();
      const base = buildCoinsStatusPayload(user);
      const payload = await enrichCoinsStatusWithInviteStats(User, user, base);
      res.json(payload);
    } catch (err) {
      console.error("[coins/status]", err && err.message);
      res.status(500).json({ error: "Failed to load coins status" });
    }
  });

  router.post("/coins/daily-login", authMiddleware, async (req, res) => {
    try {
      await claimDailyLogin(User, req.userId);
      const fresh = await finalizePendingInviteRewards(User, req.userId);
      res.json({ ok: true, coins: buildCoinsStatusPayload(fresh) });
    } catch (err) {
      const code = err && err.code ? String(err.code) : "";
      const status =
        code === "DAILY_CLAIMED" || (err && err.statusCode === 409)
          ? 409
          : err && err.statusCode === 404
            ? 404
            : 400;
      res.status(status).json({ error: err && err.message ? err.message : "Daily reward failed." });
    }
  });

  router.post("/coins/rewarded-ad", authMiddleware, async (req, res) => {
    try {
      await claimVideoReward(User, req.userId);
      const fresh = await finalizePendingInviteRewards(User, req.userId);
      res.json({ ok: true, coins: buildCoinsStatusPayload(fresh) });
    } catch (err) {
      const code = err && err.code ? String(err.code) : "";
      const status =
        code === "VIDEO_DISABLED" || (err && err.statusCode === 503)
          ? 503
          : code === "VIDEO_CAP" || (err && err.statusCode === 429)
            ? 429
            : err && err.statusCode === 404
              ? 404
              : 400;
      res.status(status).json({ error: err && err.message ? err.message : "Video reward failed." });
    }
  });

  router.post("/coins/redeem-standard", authMiddleware, async (req, res) => {
    try {
      const plan = req.body && (req.body.plan || req.body.billing);
      await redeemStandardWithCoins(User, req.userId, plan);
      const fresh = await User.findById(req.userId).lean();
      res.json({ ok: true, coins: buildCoinsStatusPayload(fresh) });
    } catch (err) {
      const code = err && err.code ? String(err.code) : "";
      const status =
        err && err.statusCode === 404
          ? 404
          : err && err.statusCode === 409
            ? 409
            : code === "COIN_STANDARD_ACTIVE"
              ? 409
              : 400;
      res.status(status).json({ error: err && err.message ? err.message : "Redeem failed." });
    }
  });

  router.post("/coins/invite/bind", authMiddleware, async (req, res) => {
    try {
      const rawCode = (req.body && req.body.code) || (req.body && req.body.referralCode);
      const merged = await bindReferralCode(User, req.userId, rawCode);
      res.json({
        ok: true,
        user: merged,
        coins: buildCoinsStatusPayload(merged)
      });
    } catch (err) {
      const status =
        err && err.statusCode === 404
          ? 404
          : err && err.statusCode === 409
            ? 409
            : err && err.statusCode === 400
              ? 400
              : 500;
      res.status(status).json({ error: err && err.message ? err.message : "Could not attach invite." });
    }
  });

  return router;
}

module.exports = { createCoinsRouter };
