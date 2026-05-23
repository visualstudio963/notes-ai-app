const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const Stripe = require("stripe");
const bodyParser = require("body-parser");
const mongoose = require("mongoose");

dotenv.config();

const app = express();
const port = 3001;

app.use(cors());

function requireEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const stripeSecretKey = requireEnv("STRIPE_SECRET_KEY");
const stripe = new Stripe(stripeSecretKey);

const stripeStandardMonthly = requireEnv("STRIPE_STANDARD_MONTHLY");
const stripeStandardYearly = requireEnv("STRIPE_STANDARD_YEARLY");
const stripeWebhookSecret = requireEnv("STRIPE_WEBHOOK_SECRET");
const mongoUri = requireEnv("MONGO_URI");

const PRICE_BY_PLAN_BILLING = {
  standard: {
    monthly: stripeStandardMonthly,
    yearly: stripeStandardYearly
  }
};

const userSchema = new mongoose.Schema(
  {
    _id: { type: String },
    email: { type: String, default: "" },
    isPremium: { type: Boolean, default: false },
    plan: { type: String, enum: ["standard"], default: null },
    billing: { type: String, enum: ["monthly", "yearly"], default: null },
    stripeCustomerId: { type: String, default: "" },
    stripeSubscriptionId: { type: String, default: "" },
    createdAt: { type: Date, default: Date.now }
  },
  { versionKey: false, collection: "stripe_users" }
);

const User = mongoose.models.StripeUser || mongoose.model("StripeUser", userSchema);

async function upgradeUserToPremium(userId, plan, billing, customerId, subscriptionId) {
  await User.findByIdAndUpdate(
    userId,
    {
      $set: {
        isPremium: true,
        plan,
        billing,
        stripeCustomerId: customerId || "",
        stripeSubscriptionId: subscriptionId || ""
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).exec();
}

// Webhook route MUST receive raw body before JSON parser middleware.
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const signature = req.headers["stripe-signature"];
  if (!signature) {
    return res.status(400).send("Missing stripe-signature header");
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, stripeWebhookSecret);
  } catch (err) {
    return res.status(400).send(`Webhook signature verification failed: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const userId = session && session.metadata ? String(session.metadata.userId || "").trim() : "";
    const plan = session && session.metadata ? String(session.metadata.plan || "").trim().toLowerCase() : "";
    const billing = session && session.metadata ? String(session.metadata.billing || "").trim().toLowerCase() : "";
    const customerId =
      typeof session.customer === "string"
        ? session.customer
        : session.customer && session.customer.id
          ? String(session.customer.id)
          : "";
    const subscriptionId =
      typeof session.subscription === "string"
        ? session.subscription
        : session.subscription && session.subscription.id
          ? String(session.subscription.id)
          : "";
    if (userId) {
      try {
        await upgradeUserToPremium(
          userId,
          plan === "standard" ? "standard" : "standard",
          billing === "yearly" ? "yearly" : "monthly",
          customerId,
          subscriptionId
        );
      } catch (err) {
        return res.status(500).send(`Failed to upgrade user: ${err.message}`);
      }
    }
  }

  return res.status(200).json({ received: true });
});

// JSON parsing for all non-webhook routes.
app.use(bodyParser.json());
app.use(express.json());

app.post("/create-checkout-session", async (req, res) => {
  try {
    const plan = String((req.body && req.body.plan) || "").trim().toLowerCase();
    const billing = String((req.body && req.body.billing) || "").trim().toLowerCase();
    const userId = String((req.body && req.body.userId) || "").trim();
    const email = String((req.body && req.body.email) || "").trim();

    if (plan !== "standard" || (billing !== "monthly" && billing !== "yearly")) {
      return res.status(400).json({
        error: "Invalid request. Use plan: standard and billing: monthly|yearly."
      });
    }
    if (!userId) {
      return res.status(400).json({ error: "userId is required" });
    }

    const selectedPriceId = PRICE_BY_PLAN_BILLING[plan][billing];
    if (!selectedPriceId) {
      return res.status(500).json({ error: "Price is not configured for this plan/billing pair." });
    }

    const existingUser = await User.findById(userId).exec();
    if (!existingUser) {
      await User.create({
        _id: userId,
        email,
        isPremium: false,
        plan: null,
        billing: null
      });
    } else if (email && existingUser.email !== email) {
      existingUser.email = email;
      await existingUser.save();
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: selectedPriceId, quantity: 1 }],
      metadata: { userId, plan, billing },
      ...(email ? { customer_email: email } : {}),
      success_url: "http://localhost:3000/success?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "http://localhost:3000/pricing"
    });

    return res.json({ url: session.url });
  } catch (err) {
    return res.status(500).json({ error: err && err.message ? err.message : "Checkout session failed." });
  }
});

app.get("/user/:id", async (req, res) => {
  try {
    const userId = String(req.params.id || "").trim();
    if (!userId) return res.status(400).json({ error: "User id is required" });
    const user = await User.findById(userId).lean();
    if (!user) return res.status(404).json({ error: "User not found" });
    return res.json(user);
  } catch (err) {
    return res.status(500).json({ error: err && err.message ? err.message : "Failed to load user." });
  }
});

mongoose
  .connect(mongoUri)
  .then(() => {
    app.listen(port, () => {
      console.log(`Stripe checkout server running on http://localhost:${port}`);
    });
  })
  .catch((err) => {
    console.error("Failed to connect MongoDB:", err.message);
    process.exit(1);
  });
