const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { publicUser } = require("../utils/serializers");

/** Synthetic email domain for accounts created via username/password only (RFC 2606 .invalid). */
const LOCAL_ACCOUNT_EMAIL_DOMAIN = "users.notesai.invalid";

function isValidEmailShape(email) {
  const e = String(email || "").trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

function localSyntheticEmail(username) {
  const u = String(username || "")
    .trim()
    .toLowerCase();
  return `${u}@${LOCAL_ACCOUNT_EMAIL_DOMAIN}`;
}

/**
 * POST /api/login and POST /auth/login — username or email + password.
 */
function createPasswordLoginHandler({ User, jwtSecret, jwtRefreshSecret }) {
  const issueSessionTokens = createIssueSessionTokens(User, jwtSecret, jwtRefreshSecret);

  return async function passwordLogin(req, res) {
    try {
      const { identifier, username, password } = req.body || {};
      const loginId = String(identifier || username || "")
        .trim()
        .toLowerCase();
      const pwd = String(password || "");

      if (!loginId || !pwd) {
        return res.status(400).json({ error: "Username and password are required" });
      }

      const user = await User.findOne({
        $or: [{ username: loginId }, { email: loginId }, { emailOrPhone: loginId }]
      });

      if (!user) {
        return res.status(400).json({ error: "Invalid username or password" });
      }

      if (!user.password) {
        return res.status(400).json({
          error: "Please log in with Google first, or complete setting a password at /set-password after Google sign-in."
        });
      }

      let valid = false;
      try {
        valid = await bcrypt.compare(pwd, user.password);
      } catch (err) {
        console.error("[auth/login] bcrypt compare error:", err.message);
        return res.status(400).json({ error: "Invalid username or password" });
      }
      if (!valid) {
        return res.status(400).json({ error: "Invalid username or password" });
      }

      const fresh = await User.findById(user._id);
      const { accessToken, refreshToken } = await issueSessionTokens(fresh._id);
      res.json({ accessToken, refreshToken, user: publicUser(fresh) });
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
  };
}

function splitGoogleDisplayName(name) {
  const n = String(name || "").trim();
  if (!n) return { firstName: "User", lastName: "" };
  const parts = n.split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

function baseUsernameFromProfile(name, email) {
  let base = String(name || "")
    .trim()
    .split(/\s+/)[0]
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "");
  if (base.length < 3) {
    base = String(email || "")
      .split("@")[0]
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "") || "user";
  }
  if (base.length < 3) base = `user${base}`;
  return base.slice(0, 28);
}

async function allocateUsername(User, name, email) {
  let base = baseUsernameFromProfile(name, email);
  if (base.length < 3) base = "user";
  for (let i = 0; i < 80; i += 1) {
    const candidate = i === 0 ? base : `${base}${Math.floor(100 + Math.random() * 899)}`.slice(0, 30);
    const exists = await User.findOne({ username: candidate }).select("_id").lean();
    if (!exists) return candidate;
  }
  return `${base}${Date.now()}`.slice(0, 30);
}

function createIssueSessionTokens(User, jwtSecret, jwtRefreshSecret) {
  return async function issueSessionTokens(userId) {
    const accessToken = jwt.sign({ id: userId }, jwtSecret, { expiresIn: "15m" });
    const refreshToken = jwt.sign({ id: userId }, jwtRefreshSecret, { expiresIn: "7d" });
    await User.updateOne({ _id: userId }, { $set: { refreshToken } });
    return { accessToken, refreshToken };
  };
}

/**
 * Create or update user from Google ID token claims (sub, email, name).
 * @returns {Promise<import("mongoose").Document>}
 */
async function upsertGoogleUserFromIdTokenPayload(User, payload, cleanDeviceId) {
  const sub = String(payload.sub || "").trim();
  const email = String(payload.email || "")
    .trim()
    .toLowerCase();
  const name = String(payload.name || "").trim();

  if (!sub || !email) {
    const err = new Error("Google did not return a complete profile");
    err.statusCode = 400;
    throw err;
  }

  let user = await User.findOne({ $or: [{ googleId: sub }, { email }] });

  if (user) {
    if (user.googleId && user.googleId !== sub) {
      const err = new Error("This email is linked to another Google account");
      err.statusCode = 409;
      throw err;
    }
    if (!user.googleId) {
      user.googleId = sub;
      user.emailVerified = true;
    }
    if (cleanDeviceId) {
      const other = await User.findOne({ deviceId: cleanDeviceId, _id: { $ne: user._id } })
        .select("_id")
        .lean();
      if (other) {
        const err = new Error("Only one account allowed per device");
        err.statusCode = 409;
        throw err;
      }
      if (!user.deviceId) user.deviceId = cleanDeviceId;
    }
    await user.save();
  } else {
    if (cleanDeviceId) {
      const taken = await User.findOne({ deviceId: cleanDeviceId }).select("_id").lean();
      if (taken) {
        const err = new Error("Only one account allowed per device");
        err.statusCode = 409;
        throw err;
      }
    }
    const { firstName, lastName } = splitGoogleDisplayName(name);
    const username = await allocateUsername(User, name, email);
    user = await User.create({
      firstName,
      lastName,
      username,
      email,
      emailOrPhone: email,
      googleId: sub,
      provider: "google",
      password: null,
      emailVerified: true,
      emailVerificationTokenHash: null,
      emailVerificationExpiresAt: null,
      deviceId: cleanDeviceId || "",
      plan: "free",
      subscriptionPlan: "free",
      membershipRole: "free",
      isPremium: false,
      premiumExpires: null
    });
  }

  return User.findById(user._id);
}

/**
 * Find existing user by Google id or email and link Google id if needed.
 * New Google users are auto-provisioned in the Passport callback (see `upsertGoogleUserFromIdTokenPayload`).
 */
async function findOrLinkGoogleUser(User, { sub, email, name, picture }) {
  const emailNorm = String(email || "")
    .trim()
    .toLowerCase();
  const googleId = String(sub || "").trim();
  if (!emailNorm || !googleId) {
    return null;
  }

  let user = await User.findOne({ $or: [{ email: emailNorm }, { googleId }] });

  if (user) {
    if (user.googleId && user.googleId !== googleId) {
      const err = new Error("This email is linked to another Google account");
      err.statusCode = 409;
      throw err;
    }
    if (!user.googleId) {
      user.googleId = googleId;
      user.provider = "google";
      user.emailVerified = true;
    }
    const pic = String(picture || "").trim();
    if (pic && user.googlePicture !== pic) {
      user.googlePicture = pic;
    }
    await user.save();
    return User.findById(user._id);
  }

  return null;
}

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

  const issueSessionTokens = createIssueSessionTokens(User, jwtSecret, jwtRefreshSecret);
  const passwordLogin = createPasswordLoginHandler({ User, jwtSecret, jwtRefreshSecret });

  router.get("/auth/check-email", authLimiter, async (req, res) => {
    try {
      const email = String(req.query.email || "")
        .trim()
        .toLowerCase();
      if (!email) {
        return res.status(400).json({ error: "email query required", available: false });
      }
      if (!isValidEmailShape(email)) {
        return res.status(400).json({ error: "Invalid email", available: false });
      }
      const existing = await User.findOne({
        $or: [{ email }, { emailOrPhone: email }]
      })
        .select("_id")
        .lean();
      res.json({ available: !existing });
    } catch (err) {
      console.error("[auth/check-email]", err.message);
      res.status(500).json({ error: "Could not check email", available: false });
    }
  });

  router.post("/register", signupLimiter, async (req, res) => {
    try {
      const firstName = String((req.body && req.body.firstName) || "").trim();
      const lastName = String((req.body && req.body.lastName) || "").trim();
      const username = String((req.body && req.body.username) || "")
        .trim()
        .toLowerCase();
      const email = String((req.body && req.body.email) || "")
        .trim()
        .toLowerCase();
      const password = String((req.body && req.body.password) || "");
      const confirmPassword = String((req.body && req.body.confirmPassword) || "");

      if (!firstName || !lastName) {
        return res.status(400).json({ error: "First name and last name are required" });
      }
      if (!email) {
        return res.status(400).json({ error: "Email is required" });
      }
      if (!isValidEmailShape(email)) {
        return res.status(400).json({ error: "Please enter a valid email address" });
      }
      if (username.length < 3 || username.length > 30) {
        return res.status(400).json({ error: "Username must be between 3 and 30 characters" });
      }
      if (!/^[a-z0-9_]+$/.test(username)) {
        return res.status(400).json({
          error: "Username may only contain lowercase letters, numbers, and underscores"
        });
      }
      if (password.length < 8) {
        return res.status(400).json({ error: "Password must be at least 8 characters" });
      }
      if (password !== confirmPassword) {
        return res.status(400).json({ error: "Passwords do not match" });
      }

      const emailOrPhone = email;

      const existingUser = await User.findOne({
        $or: [{ email }, { username }, { emailOrPhone: email }]
      })
        .select("_id")
        .lean();
      if (existingUser) {
        return res.status(400).json({
          message: "User already exists",
          error: "User already exists"
        });
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const user = await User.create({
        firstName,
        lastName,
        username,
        email,
        emailOrPhone,
        password: passwordHash,
        provider: "local",
        emailVerified: true,
        emailVerificationTokenHash: null,
        emailVerificationExpiresAt: null,
        plan: "free",
        subscriptionPlan: "free",
        membershipRole: "free",
        isPremium: false,
        premiumExpires: null
      });

      const { accessToken, refreshToken } = await issueSessionTokens(user._id);
      res.json({ accessToken, refreshToken, user: publicUser(user) });
    } catch (err) {
      if (err && err.code === 11000) {
        return res.status(400).json({
          message: "Email or username already exists",
          error: "Email or username already exists"
        });
      }
      console.error("[auth/register]", err.message);
      res.status(500).json({ message: "Server error", error: "Registration failed" });
    }
  });

  router.post("/login", authLimiter, passwordLogin);

  router.get("/auth/pending-google", (req, res) => {
    const p = req.session && req.session.pendingGoogleOAuth;
    if (!p) {
      return res.status(404).json({ error: "No pending Google registration. Start sign-in again." });
    }
    res.json({ email: p.email, name: p.name || "" });
  });

  router.post("/auth/complete-google-signup", authLimiter, async (req, res) => {
    const p = req.session && req.session.pendingGoogleOAuth;
    if (!p) {
      return res.status(400).json({ error: "No pending Google registration. Start sign-in again." });
    }

    let username = String((req.body && req.body.username) || "")
      .trim()
      .toLowerCase();
    const deviceId = String((req.body && req.body.deviceId) || "").trim();

    if (username.length < 3 || username.length > 30) {
      return res.status(400).json({ error: "Username must be between 3 and 30 characters" });
    }
    if (!/^[a-z0-9_]+$/.test(username)) {
      return res.status(400).json({
        error: "Username may only contain lowercase letters, numbers, and underscores"
      });
    }

    try {
      const taken = await User.findOne({ username }).select("_id").lean();
      if (taken) {
        return res.status(409).json({ error: "Username already taken" });
      }
      const emailExists = await User.findOne({ email: p.email }).select("_id").lean();
      if (emailExists) {
        return res.status(409).json({ error: "An account with this email already exists" });
      }
      const gidTaken = await User.findOne({ googleId: p.googleId }).select("_id").lean();
      if (gidTaken) {
        return res.status(409).json({ error: "This Google account is already registered" });
      }
      if (deviceId) {
        const devTaken = await User.findOne({ deviceId }).select("_id").lean();
        if (devTaken) {
          return res.status(409).json({ error: "Only one account allowed per device" });
        }
      }

      const user = await User.create({
        firstName: p.firstName || "User",
        lastName: p.lastName || "",
        username,
        email: p.email,
        emailOrPhone: p.email,
        googleId: p.googleId,
        provider: "google",
        password: null,
        googlePicture: p.picture || "",
        emailVerified: true,
        emailVerificationTokenHash: null,
        emailVerificationExpiresAt: null,
        deviceId: deviceId || "",
        plan: "free",
        subscriptionPlan: "free",
        membershipRole: "free",
        isPremium: false,
        premiumExpires: null
      });

      delete req.session.pendingGoogleOAuth;

      const { accessToken, refreshToken } = await issueSessionTokens(user._id);

      req.logout((logoutErr) => {
        if (logoutErr) console.error("[auth/complete-google-signup] logout:", logoutErr.message);
        res.json({ accessToken, refreshToken, user: publicUser(user) });
      });
    } catch (err) {
      if (err && err.code === 11000) {
        return res.status(409).json({ error: "Username already taken" });
      }
      console.error("[auth/complete-google-signup]", err.message);
      res.status(500).json({ error: "Could not complete registration" });
    }
  });

  router.post("/auth/google", authLimiter, (_req, res) => {
    res.status(410).json({
      error: "Use the Continue with Google button (browser redirect). Token-based Google sign-in has been removed."
    });
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

module.exports = {
  createAuthRouter,
  createPasswordLoginHandler,
  upsertGoogleUserFromIdTokenPayload,
  createIssueSessionTokens,
  findOrLinkGoogleUser,
  splitGoogleDisplayName,
  localSyntheticEmail,
  LOCAL_ACCOUNT_EMAIL_DOMAIN
};
