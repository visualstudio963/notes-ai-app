const path = require("path");
const http = require("http");
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const socketIo = require("socket.io");
const cron = require("node-cron");

const config = require("./config");
const { createAuthMiddleware } = require("./middleware/auth");
const { createApiRouter } = require("./routes");
const { createStripeWebhookHandler } = require("./features/premium/stripeWebhook");
const { createReminderChecker } = require("./jobs/reminderScheduler");

const User = require("./models/User");
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

app.use(cors({ origin: true }));

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
  emailVerificationBypassUsernames: config.emailVerificationBypassUsernames
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
      console.log(`Server http://localhost:${config.port}`);
    });
  })
  .catch((err) => {
    console.error("MongoDB connection error:", err.message);
    process.exit(1);
  });
