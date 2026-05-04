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

/** OAuth 2.0 Web client ID from Google Cloud Console (GIS / Sign in with Google). Safe to expose to the frontend. */
const googleClientId = process.env.GOOGLE_CLIENT_ID ? String(process.env.GOOGLE_CLIENT_ID).trim() : "";
/** Server-side OAuth secret (authorization code flow). Never expose to the frontend. */
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET ? String(process.env.GOOGLE_CLIENT_SECRET).trim() : "";
/**
 * OAuth callback URL used by Passport (`passport-google-oauth20`) — must match Google Cloud “Authorized redirect URI”.
 * Prefer GOOGLE_CALLBACK_URL; GOOGLE_REDIRECT_URI is a legacy alias.
 * If unset, defaults to PUBLIC_APP_URL + /auth/google/callback (fine only when API and app share one origin).
 * When the SPA is on Vercel (PUBLIC_APP_URL=https://notes-ai-app-theta.vercel.app) but the API is elsewhere, set GOOGLE_CALLBACK_URL to the API host explicitly (e.g. https://…onrender.com/auth/google/callback).
 */
const googleCallbackUrlEnv = process.env.GOOGLE_CALLBACK_URL ? String(process.env.GOOGLE_CALLBACK_URL).trim() : "";
const googleRedirectUriEnv = process.env.GOOGLE_REDIRECT_URI ? String(process.env.GOOGLE_REDIRECT_URI).trim() : "";
const googleRedirectUri =
  googleCallbackUrlEnv || googleRedirectUriEnv || `${publicAppUrl.replace(/\/$/, "")}/auth/google/callback`;

/** Session cookie signing secret (Passport OAuth state). Defaults to JWT_SECRET if unset. */
const sessionSecret = process.env.SESSION_SECRET ? String(process.env.SESSION_SECRET).trim() : jwtSecret;

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
if (!googleClientId) {
  console.warn("[config] GOOGLE_CLIENT_ID is missing. Google sign-in will be disabled.");
}
if (googleClientId && !googleClientSecret) {
  console.warn("[config] GOOGLE_CLIENT_SECRET is missing. Passport Google OAuth (/auth/google) will not work.");
}
if (googleClientId && googleClientSecret && !googleCallbackUrlEnv && !googleRedirectUriEnv) {
  console.warn(
    "[config] GOOGLE_CALLBACK_URL not set; using PUBLIC_APP_URL + /auth/google/callback. Ensure this matches Google Cloud Console."
  );
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
  mongoTlsInsecure,
  googleClientId,
  googleClientSecret,
  googleRedirectUri,
  /** Same as googleRedirectUri — explicit name for Passport callbackURL */
  googleCallbackUrl: googleRedirectUri,
  sessionSecret
};
