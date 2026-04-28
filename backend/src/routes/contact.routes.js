const express = require("express");

function createContactRouter({ ContactMessage, contactLimiter }) {
  const router = express.Router();

  router.post("/contact", contactLimiter, async (req, res) => {
    try {
      const { name, email, message } = req.body || {};
      const n = typeof name === "string" ? name.trim() : "";
      const e = typeof email === "string" ? email.trim() : "";
      const m = typeof message === "string" ? message.trim() : "";
      if (!n || !e || !m) {
        return res.status(400).json({ error: "Name, email, and message are required" });
      }
      if (n.length > 120 || e.length > 254 || m.length > 8000) {
        return res.status(400).json({ error: "One or more fields are too long" });
      }
      const simpleEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!simpleEmail.test(e)) {
        return res.status(400).json({ error: "Invalid email address" });
      }

      await ContactMessage.create({ name: n, email: e, message: m });
      res.json({ success: true });
    } catch {
      res.status(500).json({ error: "Failed to save message" });
    }
  });

  return router;
}

module.exports = { createContactRouter };
