const express = require("express");
const mongoose = require("mongoose");
const { hasActivePremium, hasStandardTierAccess } = require("../features/premium/subscriptionService");
const { PREMIUM_CODE } = require("../features/premium/createRequirePremium");

const FUTURE_MS_SLOP = 5000;

function isValidFutureDate(d) {
  if (!d || Number.isNaN(d.getTime())) return false;
  return d.getTime() > Date.now() - FUTURE_MS_SLOP;
}

function createRemindersRouter({ User, Reminder, authMiddleware, aiMemoryService }) {
  const router = express.Router();

  router.post("/ai-memory", authMiddleware, async (req, res) => {
    const { message } = req.body;
    if (!message) {
      return res.status(400).json({ error: "Message is required" });
    }

    try {
      const parsedReminder = aiMemoryService.extractReminderDetails(message);
      if (!parsedReminder) {
        return res.status(400).json({
          error:
            "Could not parse a date/time. Try: remind me tomorrow at 8am to email the client."
        });
      }

      if (!aiMemoryService.isValidFutureDate(parsedReminder.time)) {
        return res.status(400).json({ error: "Reminder time must be in the future." });
      }

      const bodyPhone = String((req.body && req.body.phone) || "").trim();
      const user = await User.findById(req.userId).select(
        "isPremium premiumExpires plan subscriptionPlan membershipRole"
      );
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      if (!hasActivePremium(user)) {
        return res.status(403).json({
          error: "Premium subscription required for AI WhatsApp reminders. Free accounts can use browser (web) reminders.",
          code: PREMIUM_CODE
        });
      }
      if (!bodyPhone) {
        return res.status(400).json({
          error: "Provide phone (E.164) in the request body for WhatsApp reminders."
        });
      }

      const reminder = await Reminder.create({
        userId: req.userId,
        type: "ai_memory",
        notificationType: "whatsapp",
        aiMessage: message,
        parsedDate: parsedReminder.time,
        message: parsedReminder.message,
        time: parsedReminder.time,
        phone: bodyPhone,
        action: "whatsapp",
        status: "pending"
      });

      res.json({
        success: true,
        reminder: {
          id: reminder._id,
          message: reminder.message,
          time: reminder.time,
          type: "ai_memory"
        },
        message: `Reminder set for ${parsedReminder.time.toLocaleString()}`
      });
    } catch {
      res.status(500).json({ error: "Failed to create reminder" });
    }
  });

  router.post("/reminder", authMiddleware, async (req, res) => {
    try {
      const { message, category, time, phone, action, noteId } = req.body;
      if (!message || !time) {
        return res.status(400).json({ error: "Message and time are required" });
      }

      const when = new Date(time);
      if (!isValidFutureDate(when)) {
        return res.status(400).json({ error: "Reminder date and time must be in the future." });
      }

      const user = await User.findById(req.userId).select(
        "isPremium premiumExpires plan subscriptionPlan membershipRole"
      );
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const resolvedAction = action || "reminder";
      const notificationType = resolvedAction === "whatsapp" ? "whatsapp" : "web";
      const resolvedPhone = phone && String(phone).trim();

      if (notificationType === "whatsapp" && !hasActivePremium(user)) {
        return res.status(403).json({
          error:
            "Premium subscription required for WhatsApp / SMS reminders. Free accounts can use Reminders → browser notifications.",
          code: PREMIUM_CODE
        });
      }

      if (notificationType === "whatsapp" && (!resolvedPhone || !String(resolvedPhone).trim())) {
        return res.status(400).json({
          error: "A verified phone number is required for WhatsApp reminders."
        });
      }

      const reminder = await Reminder.create({
        userId: req.userId,
        noteId,
        category,
        type: "note_reminder",
        notificationType,
        message,
        time: when,
        phone: resolvedPhone,
        action: resolvedAction
      });

      res.json({ reminder });
    } catch {
      res.status(500).json({ error: "Failed to create reminder" });
    }
  });

  router.get("/reminders/web", authMiddleware, async (req, res) => {
    try {
      const reminders = await Reminder.find({
        userId: req.userId,
        notificationType: "web",
        sent: false,
        status: "pending"
      })
        .populate("noteId", "text category title")
        .sort({ time: 1 });

      res.json({ reminders });
    } catch {
      res.status(500).json({ error: "Failed to fetch reminders" });
    }
  });

  router.get("/reminders", authMiddleware, async (req, res) => {
    try {
      const reminders = await Reminder.find({ userId: req.userId })
        .populate("noteId", "text category title")
        .sort({ createdAt: -1 });
      res.json({ reminders });
    } catch {
      res.status(500).json({ error: "Failed to load reminders" });
    }
  });

  router.post("/web-reminder", authMiddleware, async (req, res) => {
    try {
      const { noteId, reminderTime, message, source } = req.body || {};
      if (!reminderTime) {
        return res.status(400).json({ error: "Reminder time is required" });
      }
      if (!noteId && !message) {
        return res.status(400).json({ error: "Either noteId or message is required" });
      }

      if (source === "web_chat") {
        const u = await User.findById(req.userId)
          .select("isPremium premiumExpires plan subscriptionPlan membershipRole")
          .lean();
        if (!hasStandardTierAccess(u)) {
          return res.status(403).json({
            error: "Web Chat reminders require Standard or Premium.",
            code: "WEB_CHAT_PLAN"
          });
        }
      }

      const reminderDate = new Date(reminderTime);
      if (Number.isNaN(reminderDate.getTime())) {
        return res.status(400).json({ error: "Invalid reminder time" });
      }
      if (!isValidFutureDate(reminderDate)) {
        return res.status(400).json({ error: "Reminder date and time must be in the future." });
      }

      const reminder = await Reminder.create({
        userId: req.userId,
        noteId: noteId || null,
        type: "note_reminder",
        notificationType: "web",
        message: message || (noteId ? "Note reminder" : ""),
        time: reminderDate,
        sent: false,
        status: "pending"
      });

      res.json({
        success: true,
        reminder: {
          id: reminder._id,
          message: reminder.message,
          time: reminder.time,
          type: "web"
        }
      });
    } catch {
      res.status(500).json({ error: "Failed to create reminder" });
    }
  });

  router.put("/reminder/:id", authMiddleware, async (req, res) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid reminder id" });
    }
    try {
      const reminder = await Reminder.findOne({
        _id: req.params.id,
        userId: req.userId
      });
      if (!reminder) {
        return res.status(404).json({ error: "Reminder not found" });
      }
      if (reminder.sent || reminder.status !== "pending") {
        return res.status(400).json({ error: "Only pending reminders can be updated." });
      }

      const { message, reminderTime } = req.body;
      if (message == null && reminderTime == null) {
        return res.status(400).json({ error: "Provide message and/or reminderTime to update." });
      }

      if (reminderTime != null) {
        const next = new Date(reminderTime);
        if (Number.isNaN(next.getTime())) {
          return res.status(400).json({ error: "Invalid reminder time" });
        }
        if (!isValidFutureDate(next)) {
          return res.status(400).json({ error: "Reminder date and time must be in the future." });
        }
        reminder.time = next;
      }
      if (message != null && String(message).trim()) {
        reminder.message = String(message).trim();
      }

      await reminder.save();
      const populated = await Reminder.findById(reminder._id).populate("noteId", "text category title");
      res.json({ reminder: populated });
    } catch {
      res.status(500).json({ error: "Failed to update reminder" });
    }
  });

  router.delete("/reminder/:id", authMiddleware, async (req, res) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid reminder id" });
    }
    try {
      const deleted = await Reminder.findOneAndDelete({ _id: req.params.id, userId: req.userId });
      if (!deleted) {
        return res.status(404).json({ error: "Reminder not found" });
      }
      res.json({ success: true });
    } catch {
      res.status(500).json({ error: "Failed to delete reminder" });
    }
  });

  router.put("/reminder/:id/mark-sent", authMiddleware, async (req, res) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid reminder id" });
    }
    try {
      const reminder = await Reminder.findOneAndUpdate(
        { _id: req.params.id, userId: req.userId },
        {
          sent: true,
          sentAt: new Date(),
          status: "sent"
        },
        { new: true }
      );

      if (!reminder) {
        return res.status(404).json({ error: "Reminder not found" });
      }
      res.json({ success: true, reminder });
    } catch {
      res.status(500).json({ error: "Failed to mark reminder as sent" });
    }
  });

  return router;
}

module.exports = { createRemindersRouter };
