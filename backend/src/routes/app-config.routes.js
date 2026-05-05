const express = require("express");

function sanitizeHttpUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) return "";
  return s;
}

function createAppConfigRouter({ AppConfig, stripePublishableKey, googleClientId }) {
  const router = express.Router();

  router.get("/public/app-config", async (_req, res) => {
    try {
      const doc = await AppConfig.findOne({ key: "main" })
        .select("discordInviteUrl discordUpdatesCount tiktokUrl youtubeUrl")
        .lean();
      return res.json({
        discordInviteUrl: sanitizeHttpUrl(doc && doc.discordInviteUrl),
        discordUpdatesCount: Math.max(0, Number((doc && doc.discordUpdatesCount) || 0)),
        tiktokUrl: sanitizeHttpUrl(doc && doc.tiktokUrl),
        youtubeUrl: sanitizeHttpUrl(doc && doc.youtubeUrl),
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
