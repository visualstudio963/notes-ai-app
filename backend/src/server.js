const path = require("path");
const http = require("http");
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const socketIo = require("socket.io");
const cron = require("node-cron");
const bcrypt = require("bcrypt");

const config = require("./config");
const { createAuthMiddleware } = require("./middleware/auth");
const { createApiRouter } = require("./routes");
const { createIssueSessionTokens, createPasswordLoginHandler } = require("./routes/auth.routes");
const { configurePassport, passport } = require("./config/passport");
const session = require("express-session");
const { createStripeWebhookHandler } = require("./features/premium/stripeWebhook");
const { createReminderChecker } = require("./jobs/reminderScheduler");

const User = require("./models/User");
const { publicUser } = require("./utils/serializers");
const Note = require("./models/Note");
const Reminder = require("./models/Reminder");
const ContactMessage = require("./models/ContactMessage");
const AppConfig = require("./models/AppConfig");
const { createAdminMiddleware } = require("./middleware/admin");
const { createTouchLastActiveMiddleware } = require("./middleware/touchLastActive");
const sendWhatsAppMessage = require("./services/whatsappService");
const aiMemoryService = require("./services/aiMemoryService");

const FRONTEND_PUBLIC = path.join(__dirname, "../../frontend/public");

const app = express();
app.set("trust proxy", 1);
const server = http.createServer(app);

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${config.port} is already in use. Set PORT in .env.`);
    process.exit(1);
  }
  console.error("Server error:", err);
  process.exit(1);
});

const io = socketIo(server, {
  cors: { origin: true, methods: ["GET", "POST"] }
});

app.set("io", io);

const authMiddleware = createAuthMiddleware(jwt, config.jwtSecret);
const adminMiddleware = createAdminMiddleware(User);

const contactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  message: "Too many contact submissions, please try again later.",
  standardHeaders: true,
  legacyHeaders: false
});

const touchLastActive = createTouchLastActiveMiddleware({
  User,
  jwt,
  jwtSecret: config.jwtSecret
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: "Too many authentication attempts, please try again later.",
  standardHeaders: true,
  legacyHeaders: false
});

const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: "Too many signups from this IP, please try again later.",
  standardHeaders: true,
  legacyHeaders: false
});

app.use(cors({ origin: true, credentials: true }));

if (config.stripeSecretKey && config.stripeWebhookSecret) {
  app.post(
    "/api/stripe/webhook",
    express.raw({ type: "application/json" }),
    createStripeWebhookHandler({
      User,
      stripeSecretKey: config.stripeSecretKey,
      stripeWebhookSecret: config.stripeWebhookSecret
    })
  );
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const sessionCookieSecure = process.env.NODE_ENV === "production";
app.use(
  session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    name: "notes.sid",
    cookie: {
      httpOnly: true,
      secure: sessionCookieSecure,
      sameSite: sessionCookieSecure ? "none" : "lax",
      maxAge: 24 * 60 * 60 * 1000
    }
  })
);

configurePassport({
  User,
  googleClientId: config.googleClientId,
  googleClientSecret: config.googleClientSecret,
  googleCallbackUrl: config.googleRedirectUri
});

app.use(passport.initialize());
app.use(passport.session());

const issueSessionTokens = createIssueSessionTokens(User, config.jwtSecret, config.jwtRefreshSecret);

const passwordLogin = createPasswordLoginHandler({
  User,
  jwtSecret: config.jwtSecret,
  jwtRefreshSecret: config.jwtRefreshSecret
});

/** Same handler as POST /api/login. */
app.post("/auth/login", authLimiter, passwordLogin);

/** First-time password for Google-only accounts (Bearer access token required). */
app.post("/auth/set-password", authLimiter, authMiddleware, async (req, res) => {
  try {
    const pwd = String((req.body && req.body.password) || "");
    const confirm = String((req.body && req.body.confirmPassword) || "");
    if (pwd.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }
    if (pwd !== confirm) {
      return res.status(400).json({ error: "Passwords do not match" });
    }
    const account = await User.findById(req.userId).select("password");
    if (!account) {
      return res.status(404).json({ error: "User not found" });
    }
    if (account.password) {
      return res.status(400).json({ error: "Password already set" });
    }
    account.password = await bcrypt.hash(pwd, 10);
    await account.save();
    const fresh = await User.findById(req.userId);
    res.json({
      success: true,
      message: "Password set successfully",
      user: publicUser(fresh)
    });
  } catch (err) {
    console.error("[auth/set-password]", err && err.message);
    res.status(500).json({ error: "Server error" });
  }
});

/** Base URL of the deployed SPA (Vercel). Uses PUBLIC_APP_URL or the default production origin below. */
const DEFAULT_FRONTEND_ORIGIN = "https://notes-ai-app-theta.vercel.app";

function getFrontendBaseUrl() {
  const raw = String(process.env.PUBLIC_APP_URL || "").trim().replace(/\/$/, "");
  return raw || DEFAULT_FRONTEND_ORIGIN;
}

app.get("/admin", (req, res) => {
  res.sendFile(path.join(FRONTEND_PUBLIC, "admin.html"));
});

app.get("/success", (_req, res) => {
  res.sendFile(path.join(FRONTEND_PUBLIC, "index.html"));
});

app.get("/pricing", (_req, res) => {
  res.sendFile(path.join(FRONTEND_PUBLIC, "index.html"));
});

app.get("/billing", (_req, res) => {
  res.sendFile(path.join(FRONTEND_PUBLIC, "index.html"));
});

app.get("/choose-username", (_req, res) => {
  res.sendFile(path.join(FRONTEND_PUBLIC, "index.html"));
});

app.get("/set-password", (_req, res) => {
  res.sendFile(path.join(FRONTEND_PUBLIC, "index.html"));
});

app.get("/dashboard", (_req, res) => {
  res.sendFile(path.join(FRONTEND_PUBLIC, "index.html"));
});

/**
 * Google OAuth (Passport + passport-google-oauth20).
 * GOOGLE_CALLBACK_URL must match Google Cloud Console "Authorized redirect URI" exactly.
 */
app.get("/auth/google", authLimiter, (req, res, next) => {
  if (!config.googleClientId || !config.googleClientSecret || !config.googleRedirectUri) {
    return res.status(503).send("Google OAuth is not configured (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_CALLBACK_URL).");
  }
  passport.authenticate("google", { scope: ["profile", "email"] })(req, res, next);
});

app.get(
  "/auth/google/callback",
  authLimiter,
  passport.authenticate("google", {
    failureRedirect: `${getFrontendBaseUrl()}/?google_oauth_error=${encodeURIComponent("passport_failed")}`
  }),
  async (req, res) => {
    const frontendBase = getFrontendBaseUrl();
    console.log("Redirecting to:", process.env.PUBLIC_APP_URL);
    console.log("[auth/google/callback] Resolved frontend base:", frontendBase);
    try {
      const user = req.user;
      if (!user) {
        return res.redirect(302, `${frontendBase}/?google_oauth_error=${encodeURIComponent("user_missing")}`);
      }
      if (user.isPending) {
        return res.redirect(302, `${frontendBase}/choose-username`);
      }
      if (!user._id) {
        return res.redirect(302, `${frontendBase}/?google_oauth_error=${encodeURIComponent("user_missing")}`);
      }
      const { accessToken, refreshToken } = await issueSessionTokens(user._id);
      const wantsJson = String(req.query.format || "").toLowerCase() === "json";

      if (wantsJson) {
        const fresh = await User.findById(user._id);
        if (!fresh) {
          return res.status(500).json({ error: "User not found after Google sign-in" });
        }
        req.logout((logoutErr) => {
          if (logoutErr) console.error("[auth/google/callback] req.logout:", logoutErr.message);
          res.json({
            accessToken,
            refreshToken,
            user: publicUser(fresh)
          });
        });
        return;
      }

      const bundle = encodeURIComponent(JSON.stringify({ accessToken, refreshToken }));
      const uPw = await User.findById(user._id).select("password").lean();
      const needsPassword = !uPw || !uPw.password;
      const nextSegment = needsPassword ? "/set-password" : "/dashboard";
      const finish = () => res.redirect(302, `${frontendBase}${nextSegment}#google_oauth=${bundle}`);

      if (typeof req.logout === "function") {
        req.logout((err) => {
          if (err) console.error("[auth/google/callback] req.logout:", err.message);
          finish();
        });
        return;
      }
      finish();
    } catch (err) {
      console.error("[auth/google/callback]", err && err.message);
      res.redirect(302, `${frontendBase}/?google_oauth_error=${encodeURIComponent("sign_in_failed")}`);
    }
  }
);

app.use(
  express.static(FRONTEND_PUBLIC, {
    setHeaders: (res) => {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
    }
  })
);

io.on("connection", (socket) => {
  socket.on("authenticate", (token) => {
    try {
      const payload = jwt.verify(token, config.jwtSecret);
      socket.userId = payload.id;
      socket.join(String(payload.id));
    } catch {
      /* invalid token */
    }
  });
});

const apiRouter = createApiRouter(app, {
  User,
  Note,
  Reminder,
  ContactMessage,
  AppConfig,
  jwtSecret: config.jwtSecret,
  jwtRefreshSecret: config.jwtRefreshSecret,
  authMiddleware,
  adminMiddleware,
  authLimiter,
  signupLimiter,
  contactLimiter,
  sendWhatsAppMessage,
  aiMemoryService,
  premiumDevSecret: config.premiumDevSecret,
  stripeSecretKey: config.stripeSecretKey,
  stripeStandardMonthlyLookupKey: config.stripeStandardMonthlyLookupKey,
  stripeStandardYearlyLookupKey: config.stripeStandardYearlyLookupKey,
  stripePremiumMonthlyLookupKey: config.stripePremiumMonthlyLookupKey,
  stripePremiumYearlyLookupKey: config.stripePremiumYearlyLookupKey,
  stripePublishableKey: config.stripePublishableKey,
  openAiApiKey: config.openAiApiKey,
  publicAppUrl: config.publicAppUrl,
  emailVerificationBypassUsernames: config.emailVerificationBypassUsernames,
  googleClientId: config.googleClientId
});

app.use("/api", touchLastActive, apiLimiter, apiRouter);

const checkReminders = createReminderChecker({
  Reminder,
  sendWhatsAppMessage,
  aiMemoryService
});

cron.schedule("* * * * *", () => {
  checkReminders().catch(() => {});
});

mongoose
  .connect(config.mongoUri, config.mongooseOptions)
  .then(() => {
    server.listen(config.port, () => {
      console.log(`Server listening on port ${config.port}`);
    });
  })
  .catch((err) => {
    console.error("MongoDB connection error:", err.message);
    process.exit(1);
  });
