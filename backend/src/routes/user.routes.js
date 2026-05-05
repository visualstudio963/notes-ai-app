const express = require("express");
const bcrypt = require("bcrypt");
const { publicUser } = require("../utils/serializers");
const { finalizeInviteBonusById, ensureReferralCode } = require("../features/coins/coinService");

const USERNAME_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

function createUserRouter({ User, authMiddleware }) {
  const router = express.Router();

  router.get("/me", authMiddleware, async (req, res) => {
    try {
      let user = await User.findById(req.userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      user = await ensureReferralCode(User, user);
      await finalizeInviteBonusById(User, user._id);
      user = await User.findById(req.userId);
      return res.json({ user: publicUser(user) });
    } catch {
      return res.status(500).json({ error: "Failed to load current user" });
    }
  });

  router.get("/profile", authMiddleware, async (req, res) => {
    try {
      const user = await User.findById(req.userId).select(
        "firstName lastName username email emailOrPhone theme language emailVerified"
      );
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      res.json({ user });
    } catch {
      res.status(500).json({ error: "Failed to load profile" });
    }
  });

  const updateProfileHandler = async (req, res) => {
    try {
      const firstName = String((req.body && req.body.firstName) || "").trim();
      const lastName = String((req.body && req.body.lastName) || "").trim();
      if (!firstName || !lastName) {
        return res.status(400).json({ error: "First name and last name are required" });
      }
      const user = await User.findByIdAndUpdate(
        req.userId,
        { firstName, lastName },
        { new: true, runValidators: true }
      ).select("firstName lastName username email emailOrPhone theme language emailVerified");
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      res.json({ success: true, user });
    } catch {
      res.status(500).json({ error: "Failed to update profile" });
    }
  };

  router.put("/user/profile", authMiddleware, updateProfileHandler);
  router.put("/profile", authMiddleware, updateProfileHandler);

  router.put("/user/username", authMiddleware, async (req, res) => {
    try {
      const raw = String((req.body && req.body.username) || "")
        .trim()
        .toLowerCase();
      if (raw.length < 3 || raw.length > 30) {
        return res.status(400).json({ error: "Username must be between 3 and 30 characters" });
      }
      if (!/^[a-z0-9_]+$/.test(raw)) {
        return res.status(400).json({
          error: "Username may only contain lowercase letters, numbers, and underscores"
        });
      }

      const user = await User.findById(req.userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      if (user.username === raw) {
        user.needsUsername = false;
        await user.save();
        return res.json({ success: true, user: publicUser(user) });
      }

      /* Cooldown after the user has a finalized username (not the first provisional pick). */
      if (!user.needsUsername) {
        const last = user.usernameLastChangedAt;
        if (last) {
          const lastMs = last instanceof Date ? last.getTime() : new Date(last).getTime();
          if (!Number.isFinite(lastMs)) {
            /* invalid date — skip cooldown */
          } else {
            const nextMs = lastMs + USERNAME_COOLDOWN_MS;
            if (Date.now() < nextMs) {
              return res.status(429).json({
                error: "You can only change your username once every 7 days",
                code: "username_cooldown",
                usernameChangeAvailableAt: new Date(nextMs).toISOString()
              });
            }
          }
        }
      }

      const taken = await User.findOne({ username: raw, _id: { $ne: req.userId } })
        .select("_id")
        .lean();
      if (taken) {
        return res.status(409).json({ error: "Username already taken" });
      }

      user.username = raw;
      user.needsUsername = false;
      user.usernameLastChangedAt = new Date();
      await user.save();
      res.json({ success: true, user: publicUser(user) });
    } catch (err) {
      if (err && err.code === 11000) {
        return res.status(409).json({ error: "Username already taken" });
      }
      res.status(500).json({ error: "Failed to update username" });
    }
  });

  router.get("/user/settings", authMiddleware, async (req, res) => {
    try {
      const user = await User.findById(req.userId).select("theme language hasSeenTutorial");
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      res.json({
        settings: {
          theme: user.theme || "classic",
          language: user.language || "en",
          hasSeenTutorial: user.hasSeenTutorial !== false
        }
      });
    } catch {
      res.status(500).json({ error: "Failed to fetch settings" });
    }
  });

  router.put("/user/settings", authMiddleware, async (req, res) => {
    try {
      const { theme, language, hasSeenTutorial } = req.body || {};
      const updates = {};
      if (theme && ["classic", "normal", "advanced"].includes(theme)) {
        updates.theme = theme;
      }
      if (language) {
        updates.language = language;
      }
      if (typeof hasSeenTutorial === "boolean") {
        updates.hasSeenTutorial = hasSeenTutorial;
      }
      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: "No valid settings to update" });
      }

      const user = await User.findByIdAndUpdate(req.userId, updates, { new: true }).select(
        "theme language hasSeenTutorial"
      );

      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      res.json({
        success: true,
        settings: {
          theme: user.theme,
          language: user.language,
          hasSeenTutorial: user.hasSeenTutorial !== false
        }
      });
    } catch {
      res.status(500).json({ error: "Failed to update settings" });
    }
  });

  router.put("/user/password", authMiddleware, async (req, res) => {
    try {
      const { currentPassword, newPassword } = req.body || {};
      if (typeof newPassword !== "string" || newPassword.length < 8) {
        return res.status(400).json({ error: "New password must be at least 8 characters" });
      }

      const user = await User.findById(req.userId).select("password");
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      if (!user.password) {
        user.password = await bcrypt.hash(newPassword, 10);
        await user.save();
        return res.json({ success: true });
      }

      if (!currentPassword) {
        return res.status(400).json({ error: "Current password and new password are required" });
      }

      const valid = await bcrypt.compare(currentPassword, user.password);
      if (!valid) {
        return res.status(401).json({ error: "Current password is incorrect" });
      }

      user.password = await bcrypt.hash(newPassword, 10);
      await user.save();

      res.json({ success: true });
    } catch {
      res.status(500).json({ error: "Failed to update password" });
    }
  });

  return router;
}

module.exports = { createUserRouter };
