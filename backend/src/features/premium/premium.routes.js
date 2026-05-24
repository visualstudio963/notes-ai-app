const express = require("express");
const stripe = require("stripe");
const { getPremiumStatusPayload, getSubscriptionPlan, getUserPlan, grantPremium, syncExpiredPremiumDocument, ensureEligibleNewUserTrial } = require("./subscriptionService");

function looksLikeEmail(s) {
  return typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

function looksLikeStripePriceId(value) {
  return typeof value === "string" && /^price_[A-Za-z0-9]+$/.test(value.trim());
}

function getStripePriceIdForPlanType(planType, priceMap) {
  const key = String(planType || "").trim().toLowerCase();
  return priceMap[key] || "";
}

function getPlanTypeFromRequestBody(body) {
  const planType = String((body && (body.planType || body.plan_type || body.plan_type_id)) || "")
    .trim()
    .toLowerCase();
  if (planType) return planType;
  const plan = String((body && (body.plan || body.tier)) || "")
    .trim()
    .toLowerCase();
  const billing = String((body && body.billing) || "")
    .trim()
    .toLowerCase();
  if (!plan) return "";
  return `${plan}_${billing === "yearly" ? "yearly" : "monthly"}`;
}

function sanitizeAbsoluteUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (!/^https?:\/\//i.test(raw)) return "";
  return raw.replace(/\/$/, "");
}

function resolveCheckoutBaseUrl(req, publicAppUrl) {
  const configured = sanitizeAbsoluteUrl(publicAppUrl);
  const origin = sanitizeAbsoluteUrl(req && req.headers ? req.headers.origin : "");
  if (!origin) return configured;
  if (!configured) return origin;
  const configuredIsLocalhost = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(configured);
  const originIsRemote = !/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(origin);
  if (configuredIsLocalhost && originIsRemote) {
    return origin;
  }
  return configured;
}

/**
 * Premium status, Stripe Checkout session, dev activation.
 *
 * @param {{
 *   User: import("mongoose").Model;
 *   authMiddleware: import("express").RequestHandler;
 *   premiumDevSecret?: string | null;
 *   stripeSecretKey?: string | null;
 *   publicAppUrl?: string | null;
 * }} deps
 */
function createPremiumRouter({
  User,
  authMiddleware,
  premiumDevSecret,
  stripeSecretKey,
  stripeStandardMonthlyLookupKey,
  stripeStandardYearlyLookupKey,
  publicAppUrl
}) {
  const router = express.Router();
  const stripeClient = stripeSecretKey ? stripe(stripeSecretKey) : null;

  const STRIPE_PRICE_ID_BY_PLAN_TYPE = {
    standard_monthly: stripeStandardMonthlyLookupKey || "",
    standard_yearly: stripeStandardYearlyLookupKey || ""
  };

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
      let subscriptionStatus = null;
      let cancelAtPeriodEnd = false;
      let currentPeriodEnd = null;
      if (stripeClient && user && user.stripeSubscriptionId) {
        try {
          const sub = await stripeClient.subscriptions.retrieve(String(user.stripeSubscriptionId));
          subscriptionStatus = sub && sub.status ? String(sub.status) : null;
          cancelAtPeriodEnd = Boolean(sub && sub.cancel_at_period_end);
          currentPeriodEnd =
            sub && Number.isFinite(Number(sub.current_period_end))
              ? new Date(Number(sub.current_period_end) * 1000).toISOString()
              : null;
        } catch {
          subscriptionStatus = null;
        }
      }

      res.json({
        ...status,
        plan: getUserPlan(user),
        subscriptionPlan: getSubscriptionPlan(user),
        billingCycle: user.billingCycle === "yearly" ? "yearly" : "monthly",
        billingReady: Boolean(user.billingCustomerId),
        subscriptionStatus,
        cancelAtPeriodEnd,
        currentPeriodEnd
      });
    } catch {
      res.status(500).json({ error: "Failed to load premium status" });
    }
  });

  async function createCheckoutSessionHandler(req, res) {
    const planType = getPlanTypeFromRequestBody(req.body);
    if (!planType) {
      return res.status(400).json({
        error: "Invalid planType. Use one of: standard_monthly, standard_yearly."
      });
    }
    const [plan, billing] = planType.split("_");
    if (plan !== "standard" || (billing !== "monthly" && billing !== "yearly")) {
      return res.status(400).json({
        error: "Invalid planType. Use one of: standard_monthly, standard_yearly."
      });
    }
    if (!stripeSecretKey) {
      return res.status(503).json({ error: "Billing is not configured" });
    }
    const stripePriceId = getStripePriceIdForPlanType(planType, STRIPE_PRICE_ID_BY_PLAN_TYPE);
    if (!stripePriceId) {
      return res.status(503).json({
        error: `Stripe price ID is not configured for planType: ${planType}`
      });
    }
    const baseUrl = resolveCheckoutBaseUrl(req, publicAppUrl);
    if (!baseUrl) {
      return res.status(503).json({ error: "PUBLIC_APP_URL is not configured" });
    }

    const user = await User.findById(req.userId).select("email emailOrPhone").lean();
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const emailSource = user.email || user.emailOrPhone;
    const email = looksLikeEmail(emailSource) ? String(emailSource).trim() : undefined;

    try {
      let stripePrice = null;
      if (looksLikeStripePriceId(stripePriceId)) {
        stripePrice = await stripeClient.prices.retrieve(stripePriceId);
      } else {
        const priceResult = await stripeClient.prices.list({
          lookup_keys: [stripePriceId],
          active: true,
          limit: 1
        });
        stripePrice = Array.isArray(priceResult && priceResult.data) ? priceResult.data[0] : null;
      }
      if (!stripePrice || !stripePrice.id) {
        return res.status(500).json({ error: `No active Stripe price found for: ${stripePriceId}` });
      }
      if (!stripePrice.active) {
        return res.status(500).json({ error: `Stripe price is inactive: ${stripePriceId}` });
      }

      const session = await stripeClient.checkout.sessions.create({
        mode: "subscription",
        payment_method_types: ["card"],
        line_items: [
          {
            price: stripePrice.id,
            quantity: 1
          }
        ],
        success_url: `${baseUrl}/success?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${baseUrl}/pricing?checkout=cancel`,
        metadata: { userId: String(req.userId), plan, billing, billingCycle: billing },
        subscription_data: { metadata: { userId: String(req.userId), plan, billing, billingCycle: billing } },
        ...(email ? { customer_email: email } : {})
      });
      if (!session.url) {
        return res.status(500).json({ error: "No checkout URL" });
      }
      res.json({ url: session.url });
    } catch (e) {
      const msg = e && e.message ? String(e.message) : "Checkout failed";
      console.error("[stripe checkout]", msg);
      const stripeCode = e && e.code ? String(e.code) : "";
      if (stripeCode === "resource_missing" && /No such price/i.test(msg)) {
        return res.status(500).json({
          error:
            `Stripe cannot find this price (${stripePriceId}). Check that STRIPE_SECRET_KEY and price IDs are from the same Stripe account/mode (live vs test), and that the price exists and is active.`
        });
      }
      res.status(500).json({ error: msg });
    }
  }

  router.post("/premium/create-checkout-session", authMiddleware, createCheckoutSessionHandler);
  router.post("/create-checkout-session", authMiddleware, createCheckoutSessionHandler);

  router.post("/premium/cancel-subscription", authMiddleware, async (req, res) => {
    if (!stripeClient) {
      return res.status(503).json({ error: "Billing is not configured" });
    }
    try {
      const user = await User.findById(req.userId).select("stripeSubscriptionId").lean();
      if (!user || !user.stripeSubscriptionId) {
        return res.status(404).json({ error: "No active subscription found for this account." });
      }
      const updated = await stripeClient.subscriptions.update(String(user.stripeSubscriptionId), {
        cancel_at_period_end: true
      });
      return res.json({
        success: true,
        status: updated.status,
        cancelAtPeriodEnd: Boolean(updated.cancel_at_period_end),
        currentPeriodEnd: Number.isFinite(Number(updated.current_period_end))
          ? new Date(Number(updated.current_period_end) * 1000).toISOString()
          : null
      });
    } catch (err) {
      return res.status(500).json({ error: err && err.message ? err.message : "Failed to cancel subscription." });
    }
  });

  /** Dev / manual activation — replace with Stripe (or similar) webhook in production. */
  if (premiumDevSecret && String(premiumDevSecret).trim()) {
    router.post("/premium/activate-dev", authMiddleware, async (req, res) => {
      const { secret, days } = req.body || {};
      if (secret !== premiumDevSecret) {
        return res.status(403).json({ error: "Invalid activation secret" });
      }
      try {
        let expiresAt = null;
        if (days != null && Number.isFinite(Number(days)) && Number(days) > 0) {
          expiresAt = new Date();
          expiresAt.setDate(expiresAt.getDate() + Number(days));
        } else {
          expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        }
        const user = await grantPremium(User, req.userId, { expiresAt, source: "stripe" });
        if (!user) {
          return res.status(404).json({ error: "User not found" });
        }
        const status = getPremiumStatusPayload(user);
        res.json({ success: true, user: status });
      } catch {
        res.status(500).json({ error: "Activation failed" });
      }
    });
  }

  return router;
}

module.exports = { createPremiumRouter };
