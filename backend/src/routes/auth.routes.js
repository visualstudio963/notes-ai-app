const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { publicUser } = require("../utils/serializers");

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

  async function issueSessionTokens(userId) {
    const accessToken = jwt.sign({ id: userId }, jwtSecret, { expiresIn: "15m" });
    const refreshToken = jwt.sign({ id: userId }, jwtRefreshSecret, { expiresIn: "7d" });
    await User.updateOne({ _id: userId }, { $set: { refreshToken } });
    return { accessToken, refreshToken };
  }

  router.post("/register", signupLimiter, async (req, res) => {
    try {
      const { firstName, lastName, username, password, confirmPassword, deviceId } = req.body || {};
      const cleanFirstName = String(firstName || "").trim();
      const cleanLastName = String(lastName || "").trim();
      const rawUsername = String(username || "").trim();
      const cleanUsername = rawUsername.toLowerCase();
      const cleanPassword = String(password || "");
      const cleanConfirmPassword = String(confirmPassword || "");
      const cleanDeviceId = String(deviceId || "").trim();

      if (!cleanFirstName || !cleanLastName || !rawUsername || !cleanPassword || !cleanConfirmPassword) {
        return res.status(400).json({ error: "firstName, lastName, username, password, confirmPassword are required" });
      }
      if (rawUsername !== cleanUsername) {
        return res.status(400).json({ error: "Username must be lowercase" });
      }
      if (cleanUsername.length < 3) {
        return res.status(400).json({ error: "Username must be at least 3 characters" });
      }
      if (cleanPassword.length < 6) {
        return res.status(400).json({ error: "Password must be at least 6 characters" });
      }
      if (cleanPassword !== cleanConfirmPassword) {
        return res.status(400).json({ error: "Passwords do not match" });
      }

      const existing = await User.findOne({ username: cleanUsername });

      if (existing) {
        return res.status(409).json({ error: "Username already taken" });
      }

      if (cleanDeviceId) {
        const existingDevice = await User.findOne({ deviceId: cleanDeviceId }).select("_id").lean();
        if (existingDevice) {
          return res.status(409).json({ error: "Only one account allowed per device" });
        }
      }

      const hashedPassword = await bcrypt.hash(cleanPassword, 10);
      const syntheticEmail = `${cleanUsername}@local.notesai`;
      const user = await User.create({
        firstName: cleanFirstName,
        lastName: cleanLastName,
        username: cleanUsername,
        email: syntheticEmail,
        emailOrPhone: syntheticEmail,
        deviceId: cleanDeviceId,
        password: hashedPassword,
        emailVerified: true,
        emailVerificationTokenHash: null,
        emailVerificationExpiresAt: null,
        plan: "free",
        subscriptionPlan: "free",
        membershipRole: "free",
        isPremium: false,
        premiumExpires: null
      });

      res.status(201).json({
        user: publicUser(user),
        message: "Account created successfully."
      });
    } catch (err) {
      if (err && err.code === 11000) {
        if (err && err.keyPattern && err.keyPattern.username) {
          return res.status(409).json({ error: "Username already taken" });
        }
        if (err && err.keyPattern && err.keyPattern.deviceId) {
          return res.status(409).json({ error: "Only one account allowed per device" });
        }
        return res.status(409).json({ error: "Account already exists" });
      }
      console.error("[auth/register]", err.message);
      res.status(500).json({ error: "Registration failed" });
    }
  });

  router.post("/login", authLimiter, async (req, res) => {
    try {
      const { identifier, username, password } = req.body || {};
      const loginId = String(identifier || username || "")
        .trim()
        .toLowerCase();
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
