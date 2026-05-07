const express = require("express");

function sanitizeHttpUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) return "";
  return s;
}

function sanitizeSupportEmail(raw) {
  let s = String(raw || "").trim().replace(/^mailto:/i, "").trim().toLowerCase();
  if (!s) return "";
  if (s.length > 320) return "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return "";
  return s;
}

function createAppConfigRouter({ AppConfig, stripePublishableKey, googleClientId }) {
  const router = express.Router();

  router.get("/public/app-config", async (_req, res) => {
    try {
      res.set("Cache-Control", "no-store, max-age=0");
      const doc = await AppConfig.collection.findOne({ key: "main" });
      return res.json({
        discordInviteUrl: sanitizeHttpUrl(doc && doc.discordInviteUrl),
        discordUpdatesCount: Math.max(0, Number((doc && doc.discordUpdatesCount) || 0)),
        tiktokUrl: sanitizeHttpUrl(doc && doc.tiktokUrl),
        youtubeUrl: sanitizeHttpUrl(doc && doc.youtubeUrl),
        supportEmail: sanitizeSupportEmail(doc && doc.supportEmail),
        stripePublishableKey: stripePublishableKey || "",
        googleClientId: String(googleClientId || "").trim()
      });
    } catch {
      return res.status(500).json({ error: "Failed to load app config" });
    }
  });

  return router;
}

module.exports = { createAppConfigRouter };
