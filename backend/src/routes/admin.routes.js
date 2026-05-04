const express = require("express");
const mongoose = require("mongoose");
const {
  hasActivePremium,
  grantPremium,
  revokePremium,
  getUserPlan,
  applyProductPlan
} = require("../features/premium/subscriptionService");

function createAdminRouter({ User, Note, Reminder, ContactMessage, AppConfig, authMiddleware, adminMiddleware }) {
  const router = express.Router();

  const ACTIVE_WINDOW_MS = 7 * 60 * 1000;

  const PREMIUM_USER_QUERY = {
    $or: [
      { plan: "premium" },
      { subscriptionPlan: "premium" },
      { membershipRole: "premium" },
      { isPremium: true, $or: [{ premiumExpires: null }, { premiumExpires: { $gt: new Date() } }] }
    ]
  };

  function adminUserJson(user, activeNowOverride) {
    const plan = getUserPlan(user);
    const activeNow =
      activeNowOverride !== undefined
        ? Boolean(activeNowOverride)
        : Boolean(user.lastActive && new Date(user.lastActive).getTime() >= Date.now() - ACTIVE_WINDOW_MS);
    return {
      id: user._id,
      username: user.username,
      email: user.email || user.emailOrPhone,
      isPremium: hasActivePremium(user),
      plan,
      role: user.role || "user",
      membershipRole: plan,
      subscriptionPlan: plan,
      createdAt: user.createdAt,
      lastActive: user.lastActive,
      activeNow
    };
  }

  router.use(authMiddleware, adminMiddleware);

  router.get("/stats", async (req, res) => {
    try {
      const since = new Date(Date.now() - ACTIVE_WINDOW_MS);
      const [totalUsers, totalNotes, totalReminders, premiumUsers, activeUsers] = await Promise.all([
        User.countDocuments(),
        Note.countDocuments(),
        Reminder.countDocuments(),
        User.countDocuments(PREMIUM_USER_QUERY),
        User.countDocuments({ lastActive: { $gte: since } })
      ]);

      res.json({
        totalUsers,
        totalNotes,
        totalReminders,
        premiumUsers,
        activeUsers,
        activeWithinMinutes: ACTIVE_WINDOW_MS / 60000
      });
    } catch {
      res.status(500).json({ error: "Failed to load stats" });
    }
  });

  /** Single payload for the admin dashboard (stats + recents + aggregates). */
  router.get("/dashboard", async (req, res) => {
    try {
      const since = new Date(Date.now() - ACTIVE_WINDOW_MS);
      const [totalUsers, totalNotes, totalReminders, premiumUsers, activeUsers] = await Promise.all([
        User.countDocuments(),
        Note.countDocuments(),
        Reminder.countDocuments(),
        User.countDocuments(PREMIUM_USER_QUERY),
        User.countDocuments({ lastActive: { $gte: since } })
      ]);

      const stats = {
        totalUsers,
        totalNotes,
        totalReminders,
        premiumUsers,
        activeUsers,
        activeWithinMinutes: ACTIVE_WINDOW_MS / 60000
      };

      let notesByCategory = [];
      try {
        notesByCategory = await Note.aggregate([
          { $group: { _id: "$category", count: { $sum: 1 } } },
          { $sort: { count: -1 } }
        ]).exec();
      } catch (err) {
        console.error("[admin/dashboard] notesByCategory", err.message);
      }
      if (!Array.isArray(notesByCategory)) notesByCategory = [];

      let recentNotesDocs = [];
      try {
        recentNotesDocs = await Note.find()
          .sort({ createdAt: -1 })
          .limit(14)
          .populate("userId", "username")
          .select("category title text createdAt userId")
          .lean()
          .exec();
      } catch (err) {
        console.error("[admin/dashboard] recentNotes", err.message);
      }

      let recentReminderDocs = [];
      try {
        recentReminderDocs = await Reminder.find()
          .sort({ createdAt: -1 })
          .limit(14)
          .populate("userId", "username")
          .select("message time notificationType status sent createdAt userId")
          .lean()
          .exec();
      } catch (err) {
        console.error("[admin/dashboard] recentReminders", err.message);
      }

      let recentUserDocs = [];
      try {
        recentUserDocs = await User.find()
          .sort({ createdAt: -1 })
          .limit(12)
          .select(
            "username emailOrPhone isPremium premiumExpires plan subscriptionPlan membershipRole createdAt lastActive"
          )
          .lean()
          .exec();
      } catch (err) {
        console.error("[admin/dashboard] recentUsers", err.message);
      }

      const notesByCategoryOut = notesByCategory.map((row) => ({
        category: row._id || "—",
        count: row.count
      }));

      const recentNotes = (recentNotesDocs || []).map((n) => {
        const u = n.userId;
        const username = u && typeof u === "object" && u.username ? u.username : "—";
        const text = n.text != null ? String(n.text) : "";
        return {
          id: n._id,
          category: n.category,
          title: n.title || "",
          textPreview: text.length > 100 ? `${text.slice(0, 100)}…` : text,
          createdAt: n.createdAt,
          username
        };
      });

      const recentReminders = (recentReminderDocs || []).map((r) => {
        const u = r.userId;
        const username = u && typeof u === "object" && u.username ? u.username : "—";
        const msg = r.message != null ? String(r.message) : "";
        return {
          id: r._id,
          username,
          messagePreview: msg.length > 80 ? `${msg.slice(0, 80)}…` : msg,
          time: r.time,
          notificationType: r.notificationType || "web",
          status: r.status || "pending",
          sent: Boolean(r.sent),
          createdAt: r.createdAt
        };
      });

      const recentUsers = (recentUserDocs || []).map((u) => {
        const activeNow = u.lastActive && new Date(u.lastActive).getTime() >= Date.now() - ACTIVE_WINDOW_MS;
        return adminUserJson(u, activeNow);
      });

      res.json({
        stats,
        notesByCategory: notesByCategoryOut,
        recentNotes,
        recentReminders,
        recentUsers
      });
    } catch (err) {
      console.error("[admin/dashboard]", err);
      res.status(500).json({ error: err.message || "Failed to load dashboard" });
    }
  });

  router.get("/users", async (req, res) => {
    try {
      const users = await User.find()
        .select(
          "username emailOrPhone isPremium premiumExpires plan subscriptionPlan role membershipRole createdAt lastActive"
        )
        .sort({ createdAt: -1 })
        .lean();

      res.json({
        users: users.map((u) => {
          const activeNow = u.lastActive && new Date(u.lastActive).getTime() >= Date.now() - ACTIVE_WINDOW_MS;
          return adminUserJson(u, activeNow);
        })
      });
    } catch {
      res.status(500).json({ error: "Failed to list users" });
    }
  });

  router.delete("/users/:id", async (req, res) => {
    try {
      const targetId = req.params.id;
      if (!mongoose.Types.ObjectId.isValid(targetId)) {
        return res.status(400).json({ error: "Invalid user id" });
      }
      if (String(targetId) === String(req.userId)) {
        return res.status(400).json({ error: "You cannot delete your own account here" });
      }
      const existing = await User.findById(targetId).select("_id").lean();
      if (!existing) {
        return res.status(404).json({ error: "User not found" });
      }
      await Note.deleteMany({ userId: targetId });
      await Reminder.deleteMany({ userId: targetId });
      await User.findByIdAndDelete(targetId);
      res.json({ success: true });
    } catch {
      res.status(500).json({ error: "Failed to delete user" });
    }
  });

  /** Set product plan (alias for PATCH /users/:id/plan). */
  router.patch("/users/:id/subscription", async (req, res) => {
    try {
      const targetId = req.params.id;
      if (!mongoose.Types.ObjectId.isValid(targetId)) {
        return res.status(400).json({ error: "Invalid user id" });
      }
      const { plan } = req.body || {};
      const allowed = ["free", "standard", "premium"];
      if (!allowed.includes(plan)) {
        return res.status(400).json({ error: "Body must include plan: free | standard | premium" });
      }
      await applyProductPlan(User, targetId, plan);
      const user = await User.findById(targetId)
        .select(
          "username emailOrPhone isPremium premiumExpires plan subscriptionPlan role membershipRole createdAt lastActive"
        )
        .lean();
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      res.json({ user: adminUserJson(user) });
    } catch (err) {
      if (err && err.message === "Invalid plan") {
        return res.status(400).json({ error: err.message });
      }
      res.status(500).json({ error: "Failed to update subscription plan" });
    }
  });

  /** Canonical admin endpoint: set plan (free | standard | premium) and sync stored fields. */
  router.patch("/users/:id/plan", async (req, res) => {
    try {
      const targetId = req.params.id;
      if (!mongoose.Types.ObjectId.isValid(targetId)) {
        return res.status(400).json({ error: "Invalid user id" });
      }
      const { plan } = req.body || {};
      const allowed = ["free", "standard", "premium"];
      if (!allowed.includes(plan)) {
        return res.status(400).json({ error: "Body must include plan: free | standard | premium" });
      }
      await applyProductPlan(User, targetId, plan);
      const user = await User.findById(targetId)
        .select(
          "username emailOrPhone isPremium premiumExpires plan subscriptionPlan role membershipRole createdAt lastActive"
        )
        .lean();
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      res.json({ user: adminUserJson(user) });
    } catch (err) {
      if (err && err.message === "Invalid plan") {
        return res.status(400).json({ error: err.message });
      }
      res.status(500).json({ error: "Failed to update plan" });
    }
  });

  router.patch("/users/:id/premium", async (req, res) => {
    try {
      const targetId = req.params.id;
      if (!mongoose.Types.ObjectId.isValid(targetId)) {
        return res.status(400).json({ error: "Invalid user id" });
      }
      const { isPremium } = req.body || {};
      if (typeof isPremium !== "boolean") {
        return res.status(400).json({ error: "Body must include isPremium (boolean)" });
      }

      if (isPremium) {
        await grantPremium(User, targetId, { expiresAt: null });
      } else {
        await revokePremium(User, targetId);
      }

      const user = await User.findById(targetId)
        .select(
          "username emailOrPhone isPremium premiumExpires plan subscriptionPlan role membershipRole createdAt lastActive"
        )
        .lean();
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      res.json({ user: adminUserJson(user) });
    } catch {
      res.status(500).json({ error: "Failed to update premium" });
    }
  });

  router.patch("/users/:id/membership-role", async (req, res) => {
    try {
      const targetId = req.params.id;
      if (!mongoose.Types.ObjectId.isValid(targetId)) {
        return res.status(400).json({ error: "Invalid user id" });
      }

      const { membershipRole } = req.body || {};
      if (membershipRole !== "free" && membershipRole !== "standard" && membershipRole !== "premium") {
        return res.status(400).json({ error: "Body must include membershipRole: free | standard | premium" });
      }

      await applyProductPlan(User, targetId, membershipRole);
      const user = await User.findById(targetId)
        .select(
          "username emailOrPhone isPremium premiumExpires plan subscriptionPlan role membershipRole createdAt lastActive"
        )
        .lean();
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      res.json({ user: adminUserJson(user) });
    } catch (err) {
      if (err && err.message === "Invalid plan") {
        return res.status(400).json({ error: err.message });
      }
      res.status(500).json({ error: "Failed to update role" });
    }
  });

  router.get("/messages", async (req, res) => {
    try {
      const messages = await ContactMessage.find().sort({ createdAt: -1 }).limit(500).lean();
      res.json({
        messages: messages.map((m) => ({
          id: m._id,
          name: m.name,
          email: m.email,
          message: m.message,
          createdAt: m.createdAt
        }))
      });
    } catch {
      res.status(500).json({ error: "Failed to list messages" });
    }
  });

  router.delete("/messages/:id", async (req, res) => {
    try {
      const id = req.params.id;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ error: "Invalid message id" });
      }
      const doc = await ContactMessage.findByIdAndDelete(id);
      if (!doc) {
        return res.status(404).json({ error: "Message not found" });
      }
      res.json({ success: true });
    } catch {
      res.status(500).json({ error: "Failed to delete message" });
    }
  });

  router.get("/config/discord", async (_req, res) => {
    try {
      const doc = await AppConfig.findOne({ key: "main" }).select("discordInviteUrl discordUpdatesCount").lean();
      return res.json({
        discordInviteUrl: doc && doc.discordInviteUrl ? String(doc.discordInviteUrl) : "",
        discordUpdatesCount: Math.max(0, Number((doc && doc.discordUpdatesCount) || 0))
      });
    } catch {
      return res.status(500).json({ error: "Failed to load Discord config" });
    }
  });

  router.put("/config/discord", async (req, res) => {
    try {
      const rawUrl = String((req.body && req.body.discordInviteUrl) || "").trim();
      const updatesCountRaw = req.body && req.body.discordUpdatesCount;
      if (rawUrl && !/^https?:\/\//i.test(rawUrl)) {
        return res.status(400).json({ error: "Discord URL must start with http:// or https://" });
      }
      const discordUpdatesCount = Number.isFinite(Number(updatesCountRaw))
        ? Math.max(0, Math.floor(Number(updatesCountRaw)))
        : 0;
      const updated = await AppConfig.findOneAndUpdate(
        { key: "main" },
        { $set: { discordInviteUrl: rawUrl, discordUpdatesCount } },
        { upsert: true, new: true }
      )
        .select("discordInviteUrl discordUpdatesCount")
        .lean();
      return res.json({
        success: true,
        discordInviteUrl: updated && updated.discordInviteUrl ? String(updated.discordInviteUrl) : "",
        discordUpdatesCount: Math.max(0, Number((updated && updated.discordUpdatesCount) || 0))
      });
    } catch {
      return res.status(500).json({ error: "Failed to save Discord config" });
    }
  });

  return router;
}

module.exports = { createAdminRouter };
