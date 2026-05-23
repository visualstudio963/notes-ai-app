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

function envTrim(name) {
  const v = process.env[name];
  return v && String(v).trim() ? String(v).trim() : "";
}

const mongoUri = requireEnv("MONGO_URI");
const jwtSecret = requireEnv("JWT_SECRET");
const jwtRefreshSecret = requireEnv("JWT_REFRESH_SECRET");

/** Optional: POST /api/premium/activate-dev (local testing only) */
const premiumDevSecret = envTrim("PREMIUM_DEV_SECRET");

const stripeSecretKey = envTrim("STRIPE_SECRET_KEY");
const stripeWebhookSecret = envTrim("STRIPE_WEBHOOK_SECRET");
const stripePublishableKey = envTrim("STRIPE_PUBLISHABLE_KEY");
const stripeStandardMonthlyLookupKey = envTrim("STRIPE_STANDARD_MONTHLY");
const stripeStandardYearlyLookupKey = envTrim("STRIPE_STANDARD_YEARLY");

const publicAppUrlRaw = envTrim("PUBLIC_APP_URL");
const publicAppUrl = (publicAppUrlRaw.replace(/\/$/, "") || `http://localhost:${port}`).replace(/\/$/, "");
const mongoTlsInsecure = envTrim("MONGO_TLS_INSECURE").toLowerCase() === "true";
const emailVerificationBypassUsernames = String(process.env.EMAIL_VERIFICATION_BYPASS_USERNAMES || "")
  .split(",")
  .map((username) => username.trim().toLowerCase())
  .filter(Boolean);

const googleClientId = envTrim("GOOGLE_CLIENT_ID");
const googleClientSecret = envTrim("GOOGLE_CLIENT_SECRET");
const googleCallbackUrlEnv = envTrim("GOOGLE_CALLBACK_URL");
const googleRedirectUriEnv = envTrim("GOOGLE_REDIRECT_URI");
const googleRedirectUri =
  googleCallbackUrlEnv || googleRedirectUriEnv || `${publicAppUrl.replace(/\/$/, "")}/auth/google/callback`;

const sessionSecret = envTrim("SESSION_SECRET") || jwtSecret;

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

if (mongoTlsInsecure && process.env.NODE_ENV !== "production") {
  mongooseOptions.tls = true;
  mongooseOptions.tlsAllowInvalidCertificates = true;
  mongooseOptions.tlsAllowInvalidHostnames = true;
}

const vapidPublicKey = envTrim("VAPID_PUBLIC_KEY");
const vapidPrivateKey = envTrim("VAPID_PRIVATE_KEY");
const vapidSubject = envTrim("VAPID_SUBJECT");

const stripeConfigured =
  stripeSecretKey && stripeWebhookSecret && stripePublishableKey && stripeStandardMonthlyLookupKey;

if (!stripeSecretKey && !stripeWebhookSecret && !stripePublishableKey && !stripeStandardMonthlyLookupKey) {
  // All Stripe vars empty — skip billing warnings (typical local dev without checkout).
} else if (!stripeConfigured) {
  const missing = [];
  if (!stripeSecretKey) missing.push("STRIPE_SECRET_KEY");
  if (!stripeWebhookSecret) missing.push("STRIPE_WEBHOOK_SECRET");
  if (!stripePublishableKey) missing.push("STRIPE_PUBLISHABLE_KEY");
  if (!stripeStandardMonthlyLookupKey) missing.push("STRIPE_STANDARD_MONTHLY");
  console.warn(`[config] Stripe billing incomplete — set: ${missing.join(", ")}`);
}
if (stripeConfigured && !stripeStandardYearlyLookupKey) {
  console.warn("[config] STRIPE_STANDARD_YEARLY not set — yearly checkout stays disabled.");
}

if (!googleClientId) {
  console.warn("[config] GOOGLE_CLIENT_ID not set — Google sign-in disabled.");
} else if (!googleClientSecret) {
  console.warn("[config] GOOGLE_CLIENT_SECRET not set — Passport OAuth disabled.");
} else if (!googleCallbackUrlEnv && !googleRedirectUriEnv) {
  console.warn(
    "[config] GOOGLE_CALLBACK_URL not set — using PUBLIC_APP_URL + /auth/google/callback. Match Google Cloud Console."
  );
}

if (!vapidPublicKey && !vapidPrivateKey && !vapidSubject) {
  // All VAPID empty — skip (browser reminders still work in-app).
} else if (!vapidPublicKey || !vapidPrivateKey || !vapidSubject) {
  console.warn("[config] VAPID keys incomplete — background web push disabled.");
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
  publicAppUrl,
  emailVerificationBypassUsernames,
  mongooseOptions,
  mongoTlsInsecure,
  googleClientId,
  googleClientSecret,
  googleRedirectUri,
  googleCallbackUrl: googleRedirectUri,
  sessionSecret,
  vapidPublicKey: vapidPublicKey || null,
  vapidPrivateKey: vapidPrivateKey || null,
  vapidSubject: vapidSubject || null
};
