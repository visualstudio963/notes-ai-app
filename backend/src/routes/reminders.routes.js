const express = require("express");
const mongoose = require("mongoose");
const {
  hasStandardTierAccess,
  LEAN_USER_SUBSCRIPTION_TIER_FIELDS
} = require("../features/premium/subscriptionService");

const FUTURE_MS_SLOP = 5000;

function isValidFutureDate(d) {
  if (!d || Number.isNaN(d.getTime())) return false;
  return d.getTime() > Date.now() - FUTURE_MS_SLOP;
}

function createRemindersRouter({ User, Reminder, authMiddleware }) {
  const router = express.Router();

  router.post("/reminder", authMiddleware, async (req, res) => {
    try {
      const { message, category, time, noteId } = req.body;
      if (!message || !time) {
        return res.status(400).json({ error: "Message and time are required" });
      }

      const when = new Date(time);
      if (!isValidFutureDate(when)) {
        return res.status(400).json({ error: "Reminder date and time must be in the future." });
      }

      const reminder = await Reminder.create({
        userId: req.userId,
        noteId,
        category,
        type: "note_reminder",
        notificationType: "web",
        message,
        time: when,
        action: "reminder"
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
        const u = await User.findById(req.userId).select(LEAN_USER_SUBSCRIPTION_TIER_FIELDS).lean();
        if (!hasStandardTierAccess(u)) {
          return res.status(403).json({
            error: "Web Chat reminders require Standard.",
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
          $set: {
            sent: true,
            sentAt: new Date(),
            status: "sent"
          },
          $unset: { webPushLockUntil: 1 }
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
