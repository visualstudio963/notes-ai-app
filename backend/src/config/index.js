const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../../.env") });

const port = parseInt(process.env.PORT, 10) || parseInt(process.env.APP_PORT, 10) || 3000;

function requireEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

const mongoUri = requireEnv("MONGO_URI");
const jwtSecret = requireEnv("JWT_SECRET");
const jwtRefreshSecret = requireEnv("JWT_REFRESH_SECRET");

/** Optional: POST /api/premium/activate-dev (local testing only; remove in production) */
const premiumDevSecret = process.env.PREMIUM_DEV_SECRET ? String(process.env.PREMIUM_DEV_SECRET).trim() : "";

const stripeSecretKey = process.env.STRIPE_SECRET_KEY ? String(process.env.STRIPE_SECRET_KEY).trim() : "";
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET ? String(process.env.STRIPE_WEBHOOK_SECRET).trim() : "";
const stripePublishableKey = process.env.STRIPE_PUBLISHABLE_KEY
  ? String(process.env.STRIPE_PUBLISHABLE_KEY).trim()
  : "";
const stripeStandardMonthlyLookupKey = process.env.STRIPE_STANDARD_MONTHLY
  ? String(process.env.STRIPE_STANDARD_MONTHLY).trim()
  : "";
const stripeStandardYearlyLookupKey = process.env.STRIPE_STANDARD_YEARLY
  ? String(process.env.STRIPE_STANDARD_YEARLY).trim()
  : "";
const stripePremiumMonthlyLookupKey = process.env.STRIPE_PREMIUM_MONTHLY
  ? String(process.env.STRIPE_PREMIUM_MONTHLY).trim()
  : "";
const stripePremiumYearlyLookupKey = process.env.STRIPE_PREMIUM_YEARLY
  ? String(process.env.STRIPE_PREMIUM_YEARLY).trim()
  : "";
const openAiApiKey = process.env.OPENAI_API_KEY ? String(process.env.OPENAI_API_KEY).trim() : "";
const publicAppUrlRaw = process.env.PUBLIC_APP_URL ? String(process.env.PUBLIC_APP_URL).trim() : "";
const publicAppUrl = (publicAppUrlRaw.replace(/\/$/, "") || `http://localhost:${port}`).replace(/\/$/, "");
const mongoTlsInsecure = String(process.env.MONGO_TLS_INSECURE || "").trim().toLowerCase() === "true";
const emailVerificationBypassUsernames = String(process.env.EMAIL_VERIFICATION_BYPASS_USERNAMES || "")
  .split(",")
  .map((username) => username.trim().toLowerCase())
  .filter(Boolean);

const mongooseOptions = {
  maxPoolSize: 10,
  minPoolSize: 2,
  maxIdleTimeMS: 60000,
  connectTimeoutMS: 10000,
  socketTimeoutMS: 45000,
  serverSelectionTimeoutMS: 5000,
  retryWrites: true,
  family: 4
};

// Optional dev-only escape hatch for environments where TLS interception or broken local trust causes
// Atlas handshakes to fail with OpenSSL internal errors.
if (mongoTlsInsecure && process.env.NODE_ENV !== "production") {
  mongooseOptions.tls = true;
  mongooseOptions.tlsAllowInvalidCertificates = true;
  mongooseOptions.tlsAllowInvalidHostnames = true;
}

if (!stripeSecretKey || !stripeWebhookSecret) {
  console.warn("[config] Stripe secret/webhook keys are missing. Billing endpoints will be disabled.");
}
if (!stripePublishableKey) {
  console.warn("[config] STRIPE_PUBLISHABLE_KEY is missing. Frontend checkout configuration may be incomplete.");
}
if (
  !stripeStandardMonthlyLookupKey ||
  !stripeStandardYearlyLookupKey ||
  !stripePremiumMonthlyLookupKey ||
  !stripePremiumYearlyLookupKey
) {
  console.warn(
    "[config] Stripe lookup keys are missing. Set STRIPE_STANDARD_MONTHLY, STRIPE_STANDARD_YEARLY, STRIPE_PREMIUM_MONTHLY, STRIPE_PREMIUM_YEARLY."
  );
}
if (!openAiApiKey) {
  console.warn("[config] OPENAI_API_KEY is missing. AI reply features will be unavailable.");
}

module.exports = {
  port,
  mongoUri,
  jwtSecret,
  jwtRefreshSecret,
  premiumDevSecret: premiumDevSecret || null,
  stripeSecretKey: stripeSecretKey || null,
  stripeWebhookSecret: stripeWebhookSecret || null,
  stripePublishableKey: stripePublishableKey || null,
  stripeStandardMonthlyLookupKey: stripeStandardMonthlyLookupKey || null,
  stripeStandardYearlyLookupKey: stripeStandardYearlyLookupKey || null,
  stripePremiumMonthlyLookupKey: stripePremiumMonthlyLookupKey || null,
  stripePremiumYearlyLookupKey: stripePremiumYearlyLookupKey || null,
  openAiApiKey: openAiApiKey || null,
  publicAppUrl,
  emailVerificationBypassUsernames,
  mongooseOptions,
  mongoTlsInsecure
};
