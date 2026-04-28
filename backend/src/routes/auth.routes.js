const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { publicUser } = require("../utils/serializers");
const { sendVerificationEmail } = require("../services/emailService");

function createAuthRouter({
  User,
  jwtSecret,
  jwtRefreshSecret,
  authLimiter,
  signupLimiter,
  publicAppUrl,
  emailVerificationBypassUsernames = []
}) {
  const router = express.Router();
  const bypassSet = new Set(
    Array.isArray(emailVerificationBypassUsernames)
      ? emailVerificationBypassUsernames.map((username) => String(username || "").trim().toLowerCase()).filter(Boolean)
      : []
  );

  function isValidEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
  }

  function buildEmailVerification() {
    const token = crypto.randomBytes(32).toString("hex");
    return {
      token,
      tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
    };
  }

  async function issueSessionTokens(userId) {
    const accessToken = jwt.sign({ id: userId }, jwtSecret, { expiresIn: "15m" });
    const refreshToken = jwt.sign({ id: userId }, jwtRefreshSecret, { expiresIn: "7d" });
    await User.updateOne({ _id: userId }, { $set: { refreshToken } });
    return { accessToken, refreshToken };
  }

  router.post("/register", signupLimiter, async (req, res) => {
    try {
      const { username, email, password, phone } = req.body || {};
      const cleanEmail = String(email || "").trim().toLowerCase();
      const cleanPhone = String(phone || "").trim();
      const cleanUsername = String(username || "").trim();
      if (!cleanUsername || !cleanEmail || !password) {
        return res.status(400).json({ error: "Username, email, and password are required" });
      }
      if (!isValidEmail(cleanEmail)) {
        return res.status(400).json({ error: "Valid email is required" });
      }

      const existing = await User.findOne({
        $or: [
          { username: cleanUsername },
          { email: cleanEmail },
          { emailOrPhone: cleanEmail },
          ...(cleanPhone ? [{ phone: cleanPhone }] : [])
        ]
      });

      if (existing) {
        return res.status(409).json({ error: "Username, email, or phone already registered" });
      }

      const hashedPassword = await bcrypt.hash(password, 10);
      const verification = buildEmailVerification();
      const user = await User.create({
        firstName: "",
        lastName: "",
        username: cleanUsername,
        email: cleanEmail,
        emailOrPhone: cleanEmail,
        phone: cleanPhone,
        password: hashedPassword,
        emailVerified: false,
        emailVerificationTokenHash: verification.tokenHash,
        emailVerificationExpiresAt: verification.expiresAt,
        plan: "free",
        subscriptionPlan: "free",
        membershipRole: "free",
        isPremium: false,
        premiumExpires: null
      });

      await sendVerificationEmail({
        to: cleanEmail,
        firstName: user.firstName,
        verifyUrl: `${publicAppUrl}/?verifyEmailToken=${encodeURIComponent(verification.token)}`
      });

      res.status(201).json({
        user: publicUser(user),
        message: "Account created. Please verify your email to log in."
      });
    } catch (err) {
      if (err && err.code === 11000) {
        return res.status(409).json({ error: "Account already exists with this username, email, or phone" });
      }
      console.error("[auth/register]", err.message);
      res.status(500).json({ error: "Registration failed" });
    }
  });

  router.post("/login", authLimiter, async (req, res) => {
    try {
      const { identifier, username, password } = req.body || {};
      const loginId = String(identifier || username || "").trim();
      if (!loginId || !password) {
        return res.status(400).json({ error: "Username and password are required" });
      }

      const user = await User.findOne({ username: loginId });

      if (!user) {
        return res.status(400).json({ error: "Invalid credentials" });
      }

      let valid = false;
      try {
        valid = Boolean(user.password) && (await bcrypt.compare(password, user.password));
      } catch (err) {
        console.error("[auth/login] bcrypt compare error:", err.message);
        return res.status(400).json({ error: "Invalid credentials" });
      }
      if (!valid) {
        return res.status(400).json({ error: "Invalid credentials" });
      }

      const canBypassEmailVerification = bypassSet.has(String(user.username || "").trim().toLowerCase());
      if (!user.emailVerified && !canBypassEmailVerification) {
        return res.status(403).json({ error: "Please verify your email before logging in" });
      }

      const { accessToken, refreshToken } = await issueSessionTokens(user._id);

      res.json({ accessToken, refreshToken, user: publicUser(user) });
    } catch (err) {
      console.error("[auth/login]", err.message);
      const msg = String((err && err.message) || "");
      if (/ssl|tls|certificate|handshake|MongoNetworkError|ECONNRESET|ETIMEDOUT/i.test(msg)) {
        return res.status(503).json({
          error: "Database connection issue during login. Please check MongoDB Atlas network/TLS settings."
        });
      }
      res.status(500).json({ error: "Login failed" });
    }
  });

  router.post("/refresh", async (req, res) => {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(401).json({ error: "Refresh token required" });
    }

    try {
      const payload = jwt.verify(refreshToken, jwtRefreshSecret);
      const user = await User.findById(payload.id);
      if (!user || user.refreshToken !== refreshToken) {
        return res.status(403).json({ error: "Invalid refresh token" });
      }

      const newAccessToken = jwt.sign({ id: user._id }, jwtSecret, { expiresIn: "15m" });
      res.json({ accessToken: newAccessToken, user: publicUser(user) });
    } catch {
      return res.status(403).json({ error: "Invalid refresh token" });
    }
  });

  router.get("/verify-email", async (req, res) => {
    try {
      const token = String((req.query && req.query.token) || "").trim();
      if (!token) {
        return res.status(400).json({ error: "Verification token is required" });
      }
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      const user = await User.findOne({
        emailVerificationTokenHash: tokenHash,
        emailVerificationExpiresAt: { $gt: new Date() }
      });
      if (!user) {
        return res.status(400).json({ error: "Verification link is invalid or expired" });
      }
      user.emailVerified = true;
      user.emailVerificationTokenHash = null;
      user.emailVerificationExpiresAt = null;
      await user.save();
      return res.json({ success: true, message: "Email verified successfully. You can now log in." });
    } catch (err) {
      console.error("[auth/verify-email]", err.message);
      return res.status(500).json({ error: "Email verification failed" });
    }
  });

  return router;
}

module.exports = { createAuthRouter };
