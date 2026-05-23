const stripe = require("stripe");
const { grantStandardAccess, STRIPE_STANDARD_DURATION_MS } = require("./subscriptionService");

/**
 * Express handler: verify Stripe signature and apply plan from Checkout metadata.
 * Mount with `express.raw({ type: "application/json" })` only.
 *
 * @param {{ stripeWebhookSecret: string; stripeSecretKey: string; User: import("mongoose").Model }} deps
 */
function createStripeWebhookHandler({ stripeWebhookSecret, stripeSecretKey, User }) {
  return async (req, res) => {
    if (!stripeWebhookSecret || !stripeSecretKey) {
      return res.status(503).send("Stripe not configured");
    }
    const sig = req.headers["stripe-signature"];
    const stripeClient = stripe(stripeSecretKey);
    let event;
    try {
      event = stripeClient.webhooks.constructEvent(req.body, sig, stripeWebhookSecret);
    } catch (err) {
      console.error("[stripe webhook] signature", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const plan = session.metadata && session.metadata.plan;
      const userId = session.metadata && session.metadata.userId;
      if (!userId || plan !== "standard") {
        console.warn("[stripe webhook] missing or invalid metadata", session.id);
        return res.json({ received: true });
      }
      try {
        const startedAt =
          Number.isFinite(Number(session && session.created)) && Number(session.created) > 0
            ? new Date(Number(session.created) * 1000)
            : new Date();
        const billingCycle =
          session.metadata && (session.metadata.billingCycle === "yearly" || session.metadata.billing === "yearly")
            ? "yearly"
            : "monthly";
        const cust =
          typeof session.customer === "string"
            ? session.customer
            : session.customer && session.customer.id
              ? session.customer.id
              : null;
        const subscriptionId =
          typeof session.subscription === "string"
            ? session.subscription
            : session.subscription && session.subscription.id
              ? session.subscription.id
              : null;

        await grantStandardAccess(User, userId, {
          source: "stripe",
          durationMs: STRIPE_STANDARD_DURATION_MS,
          startedAt,
          billingCycle,
          billingCustomerId: cust || undefined,
          stripeSubscriptionId: subscriptionId || undefined
        });
      } catch (e) {
        console.error("[stripe webhook] grantStandardAccess", e.message || e);
        return res.status(500).json({ error: "update failed" });
      }
    }

    if (event.type === "invoice.paid" || event.type === "invoice.payment_succeeded") {
      const invoice = event.data.object || {};
      const subscriptionId =
        typeof invoice.subscription === "string"
          ? invoice.subscription
          : invoice.subscription && invoice.subscription.id
            ? invoice.subscription.id
            : null;
      if (subscriptionId) {
        try {
          const user = await User.findOne({ stripeSubscriptionId: subscriptionId }).select("_id premiumExpires").lean();
          if (user) {
            const nowMs = Date.now();
            let baseMs = nowMs;
            const existing = user.premiumExpires ? new Date(user.premiumExpires).getTime() : 0;
            if (Number.isFinite(existing) && existing > nowMs) baseMs = existing;
            const expiresAt = new Date(baseMs + STRIPE_STANDARD_DURATION_MS);
            await grantStandardAccess(User, user._id, {
              source: "stripe",
              expiresAt,
              stripeSubscriptionId: subscriptionId
            });
          }
        } catch (e) {
          console.error("[stripe webhook] invoice extend", e.message || e);
        }
      }
    }

    // Access ends at premiumExpires (30-day window); cron/syncExpired revert to Free — do not revoke early on cancel.

    res.json({ received: true });
  };
}

module.exports = { createStripeWebhookHandler };
