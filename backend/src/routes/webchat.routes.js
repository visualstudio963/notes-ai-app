const express = require("express");
const {
  hasWebChatOpenAiAccess,
  computeOpenAiWebChatUsage,
  computeOpenAiUsagePeriod,
  OPENAI_WEB_CHAT_MONTHLY_LIMIT
} = require("../features/premium/subscriptionService");

function sanitizeReply(raw) {
  return String(raw || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1200);
}

function createWebChatRouter({ User, authMiddleware, openAiApiKey }) {
  const router = express.Router();

  router.post("/web-chat/ai-reply", authMiddleware, async (req, res) => {
    if (!openAiApiKey) {
      return res.status(503).json({ error: "OpenAI is not configured on the server." });
    }

    const message = String((req.body && req.body.message) || "").trim();
    if (!message) return res.status(400).json({ error: "Message is required" });

    try {
      const user = await User.findById(req.userId)
        .select("isPremium premiumExpires plan membershipRole subscriptionPlan premiumStartedAt createdAt webChatOpenAiPeriod webChatOpenAiUsed")
        .lean();

      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      if (!hasWebChatOpenAiAccess(user)) {
        return res.status(403).json({
          error: "OpenAI replies are available on Premium only.",
          code: "WEB_CHAT_OPENAI_PLAN",
          usage: null
        });
      }

      const period = computeOpenAiUsagePeriod(user);
      const used =
        user.webChatOpenAiPeriod === period ? Number(user.webChatOpenAiUsed || 0) : 0;
      if (used >= OPENAI_WEB_CHAT_MONTHLY_LIMIT) {
        return res.status(429).json({
          error: "Monthly OpenAI limit reached.",
          code: "OPENAI_LIMIT",
          usage: computeOpenAiWebChatUsage(user)
        });
      }

      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${openAiApiKey}`
        },
        body: JSON.stringify({
          model: "gpt-4.1-mini",
          input: [
            {
              role: "system",
              content:
                "You are Notes AI assistant in a notes/reminders app. Always reply in the same language as the user's latest message (if they write Albanian, answer in Albanian; if English, answer in English). Do not follow app UI or device locale — only mirror the user's writing language. Keep answers concise, practical, and safe."
            },
            { role: "user", content: message }
          ],
          max_output_tokens: 220
        })
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const err = data && data.error && data.error.message ? data.error.message : "OpenAI request failed.";
        return res.status(502).json({ error: err });
      }

      const reply =
        sanitizeReply(data.output_text) ||
        sanitizeReply(
          Array.isArray(data.output)
            ? data.output
                .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
                .map((c) => c.text || "")
                .join(" ")
            : ""
        );

      if (!reply) return res.status(502).json({ error: "OpenAI returned an empty reply." });

      const updated = await User.findByIdAndUpdate(
        req.userId,
        [
          {
            $set: {
              webChatOpenAiPeriod: period,
              webChatOpenAiUsed: {
                $cond: {
                  if: { $eq: ["$webChatOpenAiPeriod", period] },
                  then: { $add: [{ $ifNull: ["$webChatOpenAiUsed", 0] }, 1] },
                  else: 1
                }
              }
            }
          }
        ],
        { new: true }
      )
        .select("webChatOpenAiPeriod webChatOpenAiUsed isPremium premiumExpires plan membershipRole subscriptionPlan premiumStartedAt createdAt")
        .lean();

      const usage = updated ? computeOpenAiWebChatUsage(updated) : computeOpenAiWebChatUsage(user);

      return res.json({ reply, usage });
    } catch (err) {
      return res.status(500).json({ error: err && err.message ? err.message : "Failed to get AI reply." });
    }
  });

  return router;
}

module.exports = { createWebChatRouter };
