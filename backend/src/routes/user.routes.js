const express = require("express");
const bcrypt = require("bcrypt");
const { publicUser } = require("../utils/serializers");

function createUserRouter({ User, authMiddleware }) {
  const router = express.Router();

  router.get("/me", authMiddleware, async (req, res) => {
    try {
      const user = await User.findById(req.userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      return res.json({ user: publicUser(user) });
    } catch {
      return res.status(500).json({ error: "Failed to load current user" });
    }
  });

  router.get("/profile", authMiddleware, async (req, res) => {
    try {
      const user = await User.findById(req.userId).select(
        "firstName lastName username email emailOrPhone phone theme language emailVerified"
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
      ).select("firstName lastName username email emailOrPhone phone theme language emailVerified");
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

  router.get("/user/settings", authMiddleware, async (req, res) => {
    try {
      const user = await User.findById(req.userId).select("theme language");
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      res.json({
        settings: {
          theme: user.theme || "classic",
          language: user.language || "en"
        }
      });
    } catch {
      res.status(500).json({ error: "Failed to fetch settings" });
    }
  });

  router.put("/user/settings", authMiddleware, async (req, res) => {
    try {
      const { theme, language } = req.body;
      const updates = {};
      if (theme && ["classic", "normal", "advanced"].includes(theme)) {
        updates.theme = theme;
      }
      if (language) {
        updates.language = language;
      }
      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: "No valid settings to update" });
      }

      const user = await User.findByIdAndUpdate(req.userId, updates, { new: true }).select(
        "theme language"
      );

      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      res.json({
        success: true,
        settings: {
          theme: user.theme,
          language: user.language
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
