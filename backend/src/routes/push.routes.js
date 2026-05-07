const express = require("express");

function normalizeSubscription(body) {
  const raw = body && body.subscription ? body.subscription : body;
  if (!raw || typeof raw !== "object") return null;
  const endpoint = typeof raw.endpoint === "string" ? raw.endpoint.trim() : "";
  const keys = raw.keys && typeof raw.keys === "object" ? raw.keys : null;
  const p256dh = keys && typeof keys.p256dh === "string" ? keys.p256dh : "";
  const auth = keys && typeof keys.auth === "string" ? keys.auth : "";
  if (!endpoint || !p256dh || !auth) return null;
  return { endpoint, keys: { p256dh, auth } };
}

function createPushRouter({ User, authMiddleware, vapidPublicKey }) {
  const router = express.Router();

  router.get("/push/public-key", (req, res) => {
    res.json({ publicKey: vapidPublicKey || null });
  });

  router.post("/push/subscribe", authMiddleware, async (req, res) => {
    if (!vapidPublicKey) {
      return res.status(503).json({ error: "Push is not configured on this server." });
    }
    const sub = normalizeSubscription(req.body || {});
    if (!sub) {
      return res.status(400).json({ error: "Invalid push subscription payload." });
    }
    try {
      const user = await User.findById(req.userId).select("pushSubscriptions");
      if (!user) {
        return res.status(404).json({ error: "User not found." });
      }
      const list = Array.isArray(user.pushSubscriptions) ? user.pushSubscriptions.slice() : [];
      const next = list.filter((s) => s && s.endpoint !== sub.endpoint);
      next.push({
        endpoint: sub.endpoint,
        keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
        createdAt: new Date()
      });
      user.pushSubscriptions = next;
      await user.save();
      res.json({ success: true });
    } catch (err) {
      console.error("[push/subscribe]", err && err.message);
      res.status(500).json({ error: "Failed to save subscription." });
    }
  });

  router.delete("/push/unsubscribe", authMiddleware, async (req, res) => {
    const endpoint =
      typeof (req.body && req.body.endpoint) === "string" ? String(req.body.endpoint).trim() : "";
    if (!endpoint) {
      return res.status(400).json({ error: "endpoint is required." });
    }
    try {
      await User.updateOne({ _id: req.userId }, { $pull: { pushSubscriptions: { endpoint } } });
      res.json({ success: true });
    } catch (err) {
      console.error("[push/unsubscribe]", err && err.message);
      res.status(500).json({ error: "Failed to remove subscription." });
    }
  });

  return router;
}

module.exports = { createPushRouter };
