const stripe = require("stripe");
const { applyProductPlan } = require("./subscriptionService");

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
      const billingCycle =
        session.metadata && (session.metadata.billingCycle === "yearly" || session.metadata.billing === "yearly")
          ? "yearly"
          : "monthly";
      const userId = session.metadata && session.metadata.userId;
      if (!userId || (plan !== "standard" && plan !== "premium")) {
        console.warn("[stripe webhook] missing or invalid metadata", session.id);
        return res.json({ received: true });
      }
      try {
        const startedAt =
          Number.isFinite(Number(session && session.created)) && Number(session.created) > 0
            ? new Date(Number(session.created) * 1000)
            : new Date();
        await applyProductPlan(User, userId, plan, { startedAt, billingCycle });
        const cust =
          typeof session.customer === "string"
            ? session.customer
            : session.customer && session.customer.id;
        const subscriptionId =
          typeof session.subscription === "string"
            ? session.subscription
            : session.subscription && session.subscription.id
              ? session.subscription.id
              : null;
        await User.findByIdAndUpdate(
          userId,
          {
            $set: {
              ...(cust ? { billingCustomerId: cust } : {}),
              ...(subscriptionId ? { stripeSubscriptionId: subscriptionId } : {})
            }
          }
        ).exec();
      } catch (e) {
        console.error("[stripe webhook] applyProductPlan", e.message || e);
        return res.status(500).json({ error: "update failed" });
      }
    }

    if (event.type === "customer.subscription.deleted" || event.type === "invoice.payment_failed") {
      const payload = event.data.object || {};
      const customerId =
        typeof payload.customer === "string"
          ? payload.customer
          : payload.customer && payload.customer.id
            ? payload.customer.id
            : null;
      const subscriptionId =
        typeof payload.subscription === "string"
          ? payload.subscription
          : payload.id && event.type === "customer.subscription.deleted"
            ? payload.id
            : null;
      if (customerId || subscriptionId) {
        await User.updateOne(
          {
            $or: [
              ...(customerId ? [{ billingCustomerId: customerId }] : []),
              ...(subscriptionId ? [{ stripeSubscriptionId: subscriptionId }] : [])
            ]
          },
          {
            $set: {
              isPremium: false,
              plan: "free",
              subscriptionPlan: "free",
              membershipRole: "free",
              premiumExpires: null
            }
          }
        ).exec();
      }
    }

    res.json({ received: true });
  };
}

module.exports = { createStripeWebhookHandler };
