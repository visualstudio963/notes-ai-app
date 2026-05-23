const express = require("express");
const dotenv = require("dotenv");
const Stripe = require("stripe");
const mongoose = require("mongoose");
const User = require("./src/models/User");
const { grantStandardAccess, STRIPE_STANDARD_DURATION_MS } = require("./src/features/premium/subscriptionService");

dotenv.config();

const app = express();
const port = 3001;
const stripeSecretKey = String(process.env.STRIPE_SECRET_KEY || "").trim();
const stripeWebhookSecret = String(process.env.STRIPE_WEBHOOK_SECRET || "").trim();
const mongoUri = String(process.env.MONGO_URI || "").trim();
const stripe = stripeSecretKey ? new Stripe(stripeSecretKey) : null;

async function activateUserPlan({ userId, email, plan, billing, customerId, subscriptionId }) {
  const safeBilling = billing === "yearly" ? "yearly" : "monthly";
  const normalizedEmail = String(email || "").trim().toLowerCase();

  let targetId = userId ? String(userId).trim() : "";
  if (!targetId && normalizedEmail) {
    const found = await User.findOne({
      $or: [{ email: normalizedEmail }, { emailOrPhone: normalizedEmail }]
    })
      .select("_id")
      .lean();
    if (found) targetId = String(found._id);
  }
  if (!targetId) {
    console.warn("[stripe webhook] No userId/email available for activation");
    return;
  }

  const updated = await grantStandardAccess(User, targetId, {
    source: "stripe",
    durationMs: STRIPE_STANDARD_DURATION_MS,
    billingCycle: safeBilling,
    billingCustomerId: customerId || undefined,
    stripeSubscriptionId: subscriptionId || undefined
  });

  if (normalizedEmail && updated) {
    await User.updateOne(
      { _id: targetId },
      { $set: { email: normalizedEmail, emailOrPhone: normalizedEmail } }
    ).exec();
  }

  if (!updated) {
    console.warn("[stripe webhook] User not found for activation", { userId: targetId, email: normalizedEmail });
    return;
  }
  console.log("[stripe webhook] User activated:", String(updated._id), updated.plan, updated.standardSource);
}

function webhookHandler(req, res) {
  if (!stripe || !stripeWebhookSecret) {
    return res.status(503).json({ error: "Stripe webhook is not configured. Set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET." });
  }

  const signature = req.headers["stripe-signature"];
  if (!signature) {
    return res.status(400).json({ error: "Missing stripe-signature header." });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, stripeWebhookSecret);
  } catch (err) {
    return res.status(400).json({ error: `Webhook signature verification failed: ${err.message}` });
  }

  console.log("[stripe webhook] received event:", event.type, event.id);

  Promise.resolve()
    .then(async () => {
      if (event.type === "checkout.session.completed") {
        const session = event.data.object || {};
        const metadata = session.metadata || {};
        const userId = String(metadata.userId || "").trim();
        const plan = String(metadata.plan || "").trim().toLowerCase();
        const billing = String(metadata.billing || "").trim().toLowerCase();
        const email =
          (session.customer_details && session.customer_details.email) ||
          session.customer_email ||
          "";
        const customerId =
          typeof session.customer === "string"
            ? session.customer
            : session.customer && session.customer.id
              ? session.customer.id
              : "";
        const subscriptionId =
          typeof session.subscription === "string"
            ? session.subscription
            : session.subscription && session.subscription.id
              ? session.subscription.id
              : "";
        await activateUserPlan({ userId, email, plan, billing, customerId, subscriptionId });
      }

      if (event.type === "invoice.paid" || event.type === "invoice.payment_succeeded") {
        const invoice = event.data.object || {};
        const customerId =
          typeof invoice.customer === "string"
            ? invoice.customer
            : invoice.customer && invoice.customer.id
              ? invoice.customer.id
              : "";
        const subscriptionId =
          typeof invoice.subscription === "string"
            ? invoice.subscription
            : invoice.subscription && invoice.subscription.id
              ? invoice.subscription.id
              : "";
        if (!subscriptionId) return;

        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        const metadata = (subscription && subscription.metadata) || {};
        const userId = String(metadata.userId || "").trim();
        const plan = String(metadata.plan || "").trim().toLowerCase();
        const billing = String(metadata.billing || "").trim().toLowerCase();
        const email = (invoice.customer_email || "").trim();
        await activateUserPlan({ userId, email, plan, billing, customerId, subscriptionId });
      }
    })
    .catch((err) => {
      console.error("[stripe webhook] activation error:", err.message);
    });

  return res.sendStatus(200);
}

// Keep raw body for Stripe webhook compatibility.
app.post("/webhook", express.raw({ type: "application/json" }), webhookHandler);
app.post("/api/webhook", express.raw({ type: "application/json" }), webhookHandler);

if (!mongoUri) {
  console.error("Missing MONGO_URI in .env");
  process.exit(1);
}

mongoose
  .connect(mongoUri)
  .then(() => {
    app.listen(port, () => {
      console.log(`Stripe webhook server listening on http://localhost:${port}`);
    });
  })
  .catch((err) => {
    console.error("Failed to connect MongoDB:", err.message);
    process.exit(1);
  });
