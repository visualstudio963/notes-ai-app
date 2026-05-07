const express = require("express");
const mongoose = require("mongoose");
const { requireStaffMin, STAFF_RANK } = require("../middleware/admin");
const {
  hasActivePremium,
  grantPremium,
  revokePremium,
  getUserPlan,
  applyProductPlan,
  adminGrantPremiumMonths,
  adminGrantPremiumLifetime
} = require("../features/premium/subscriptionService");

const STAFF_PANEL_ROLES = new Set(["admin", "moderator", "support"]);
const STAFF_ASSIGNABLE_ROLES = ["user", "admin", "moderator", "support"];

/** @typedef {{ notes?: number; reminders?: number; invites?: number }} AdminUserCounts */

function escapeMongoRegex(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Parallel count maps keyed by User id string.
 * @returns {Promise<{ notes: Map<string, number>; reminders: Map<string, number>; invites: Map<string, number> }>}
 */
async function enrichUserAggregateCounts(User, Note, Reminder, userIds) {
  const oids = (userIds || [])
    .map((id) => (mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : null))
    .filter(Boolean);

  const emptyMaps = () => ({
    notes: new Map(),
    reminders: new Map(),
    invites: new Map()
  });

  if (!oids.length) {
    return emptyMaps();
  }

  const [noteRows, remRows, inviteRows] = await Promise.all([
    Note.aggregate([{ $match: { userId: { $in: oids } } }, { $group: { _id: "$userId", c: { $sum: 1 } } }]).exec(),
    Reminder.aggregate([
      { $match: { userId: { $in: oids } } },
      { $group: { _id: "$userId", c: { $sum: 1 } } }
    ]).exec(),
    User.aggregate([
      { $match: { referredByUserId: { $in: oids } } },
      { $group: { _id: "$referredByUserId", c: { $sum: 1 } } }
    ]).exec()
  ]);

  /** @type {Map<string, number>} */
  const notes = new Map((noteRows || []).map((r) => [String(r._id), r.c]));
  /** @type {Map<string, number>} */
  const reminders = new Map((remRows || []).map((r) => [String(r._id), r.c]));
  /** @type {Map<string, number>} */
  const invites = new Map((inviteRows || []).map((r) => [String(r._id), r.c]));

  return { notes, reminders, invites };
}

function activeNowFlag(user, activeWindowMs) {
  return Boolean(user.lastActive && new Date(user.lastActive).getTime() >= Date.now() - activeWindowMs);
}

/**
 * @param {object} user lean
 * @param {boolean} [activeNowOverride]
 * @param {AdminUserCounts} [counts]
 */
function adminUserJson(user, activeWindowMs, activeNowOverride, counts) {
  const plan = getUserPlan(user);
  let activeNow;
  if (activeNowOverride !== undefined) activeNow = Boolean(activeNowOverride);
  else activeNow = activeNowFlag(user, activeWindowMs);

  const staffRoleRaw = typeof user.role === "string" ? user.role : "user";
  /** @type {string} staff role exposed (panel role for customers stays "user" unless escalated) */
  const panelRole = STAFF_PANEL_ROLES.has(staffRoleRaw.toLowerCase()) ? staffRoleRaw.toLowerCase() : "user";

  return {
    id: user._id,
    username: user.username,
    email: user.email || user.emailOrPhone,
    isPremium: hasActivePremium(user),
    plan,
    staffRole: panelRole === "user" ? "user" : panelRole,
    /** @deprecated Prefer staffRole */
    role: panelRole === "user" ? "user" : panelRole,
    membershipRole: plan,
    subscriptionPlan: plan,
    createdAt: user.createdAt,
    lastActive: user.lastActive,
    activeNow,
    premiumExpires: user.premiumExpires ? new Date(user.premiumExpires).toISOString() : null,
    ...(counts
      ? {
          notesCount: counts.notes ?? 0,
          remindersCount: counts.reminders ?? 0,
          invitedFriendsCount: counts.invites ?? 0
        }
      : {})
  };
}

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

  router.use(authMiddleware, adminMiddleware);

  router.get("/me", async (req, res) => {
    const rank = req.staffRank || 0;
    res.json({
      username: (req.adminUser && req.adminUser.username) || "",
      staffRole: req.staffRole,
      staffRank: rank,
      capabilities: {
        canReadUsers: rank >= STAFF_RANK.SUPPORT,
        canWritePlans: rank >= STAFF_RANK.MODERATOR,
        canGrantPremium: rank >= STAFF_RANK.MODERATOR,
        canDeleteContactMessages: rank >= STAFF_RANK.MODERATOR,
        canDeleteUsers: rank >= STAFF_RANK.ADMIN,
        canChangeStaffRoles: rank >= STAFF_RANK.ADMIN,
        canEditDiscord: rank >= STAFF_RANK.SUPPORT
      },
      activeWithinMinutes: ACTIVE_WINDOW_MS / 60000
    });
  });

  /** Standard-tier access: stored standard, active 7-day trial, or coins-unlocked standard — excludes premium bucket. */
  function standardEffectiveUserQuery(now = new Date()) {
    return {
      $and: [
        { $nor: [PREMIUM_USER_QUERY] },
        {
          $or: [
            { plan: "standard" },
            { subscriptionPlan: "standard" },
            { membershipRole: "standard" },
            { trialEndsAt: { $gt: now } },
            { standardCoinExpiresAt: { $gt: now } }
          ]
        }
      ]
    };
  }

  /** Non-overlapping Standard buckets (priority: paid stored → coin unlock → trial). Excludes premium/pro bucket. */
  function standardBreakdownQueries(now = new Date()) {
    const notPremium = { $nor: [PREMIUM_USER_QUERY] };
    const storedStandard = {
      $or: [{ plan: "standard" }, { subscriptionPlan: "standard" }, { membershipRole: "standard" }]
    };
    const notStoredStandard = {
      $and: [
        { plan: { $ne: "standard" } },
        { subscriptionPlan: { $ne: "standard" } },
        { membershipRole: { $ne: "standard" } }
      ]
    };
    return {
      standardPaidUsers: { $and: [notPremium, storedStandard] },
      standardCoinUsers: {
        $and: [notPremium, notStoredStandard, { standardCoinExpiresAt: { $gt: now } }]
      },
      standardTrialUsers: {
        $and: [
          notPremium,
          notStoredStandard,
          { $nor: [{ standardCoinExpiresAt: { $gt: now } }] },
          { trialEndsAt: { $gt: now } }
        ]
      }
    };
  }

  router.get("/stats", requireStaffMin(STAFF_RANK.SUPPORT), async (_req, res) => {
    try {
      const since = new Date(Date.now() - ACTIVE_WINDOW_MS);
      const now = new Date();
      const breakdownQ = standardBreakdownQueries(now);
      const [
        totalUsers,
        totalNotes,
        totalReminders,
        premiumUsers,
        standardUsers,
        standardPaidUsers,
        standardCoinUsers,
        standardTrialUsers,
        activeUsers
      ] = await Promise.all([
        User.countDocuments(),
        Note.countDocuments(),
        Reminder.countDocuments(),
        User.countDocuments(PREMIUM_USER_QUERY),
        User.countDocuments(standardEffectiveUserQuery(now)),
        User.countDocuments(breakdownQ.standardPaidUsers),
        User.countDocuments(breakdownQ.standardCoinUsers),
        User.countDocuments(breakdownQ.standardTrialUsers),
        User.countDocuments({ lastActive: { $gte: since } })
      ]);
      const freeUsers = Math.max(0, totalUsers - premiumUsers - standardUsers);

      res.json({
        totalUsers,
        totalNotes,
        totalReminders,
        premiumUsers,
        proUsers: premiumUsers,
        standardUsers,
        freeUsers,
        activeUsers,
        activeWithinMinutes: ACTIVE_WINDOW_MS / 60000,
        standardBreakdown: {
          paid: standardPaidUsers,
          coin: standardCoinUsers,
          trial: standardTrialUsers
        }
      });
    } catch {
      res.status(500).json({ error: "Failed to load stats" });
    }
  });

  /** Single payload for the admin dashboard (stats + recents + aggregates). */
  router.get("/dashboard", requireStaffMin(STAFF_RANK.SUPPORT), async (_req, res) => {
    try {
      const since = new Date(Date.now() - ACTIVE_WINDOW_MS);
      const sevenDaysAgo = new Date(Date.now() - 7 * 86400000);
      const startUtcDay = new Date();
      startUtcDay.setUTCHours(0, 0, 0, 0);
      const signupsRangeStart = new Date(startUtcDay);
      signupsRangeStart.setUTCDate(signupsRangeStart.getUTCDate() - 6);

      const now = new Date();
      const breakdownQ = standardBreakdownQueries(now);
      const [
        totalUsers,
        totalNotes,
        totalReminders,
        premiumUsers,
        standardUsers,
        standardPaidUsers,
        standardCoinUsers,
        standardTrialUsers,
        activeUsers,
        signupsLast7Days,
        remindersByStatus,
        activeUsersToday,
        signupsByDayRows,
        remindersSentAggregate
      ] = await Promise.all([
        User.countDocuments(),
        Note.countDocuments(),
        Reminder.countDocuments(),
        User.countDocuments(PREMIUM_USER_QUERY),
        User.countDocuments(standardEffectiveUserQuery(now)),
        User.countDocuments(breakdownQ.standardPaidUsers),
        User.countDocuments(breakdownQ.standardCoinUsers),
        User.countDocuments(breakdownQ.standardTrialUsers),
        User.countDocuments({ lastActive: { $gte: since } }),
        User.countDocuments({ createdAt: { $gte: sevenDaysAgo } }),
        Reminder.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }, { $sort: { count: -1 } }]).exec(),
        User.countDocuments({ lastActive: { $gte: startUtcDay } }),
        User.aggregate([
          { $match: { createdAt: { $gte: signupsRangeStart } } },
          {
            $group: {
              _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "UTC" } },
              count: { $sum: 1 }
            }
          }
        ]).exec(),
        Reminder.countDocuments({ sent: true })
      ]);

      const freeUsers = Math.max(0, totalUsers - premiumUsers - standardUsers);

      const stats = {
        totalUsers,
        totalNotes,
        totalReminders,
        premiumUsers,
        proUsers: premiumUsers,
        standardUsers,
        freeUsers,
        activeUsers,
        activeUsersToday,
        activeWithinMinutes: ACTIVE_WINDOW_MS / 60000,
        remindersSent: remindersSentAggregate,
        standardBreakdown: {
          paid: standardPaidUsers,
          coin: standardCoinUsers,
          trial: standardTrialUsers
        }
      };

      const byDayMap = new Map((signupsByDayRows || []).map((row) => [row._id, row.count]));
      const signupsByDay = [];
      for (let i = 6; i >= 0; i -= 1) {
        const d = new Date(startUtcDay);
        d.setUTCDate(d.getUTCDate() - i);
        const key = d.toISOString().slice(0, 10);
        signupsByDay.push({ day: key, count: byDayMap.get(key) || 0 });
      }

      const analytics = {
        signupsLast7Days,
        signupsByDay,
        remindersByStatus: (remindersByStatus || []).map((row) => ({
          status: row._id || "—",
          count: row.count
        }))
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
          .limit(10)
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
          .limit(10)
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
          .limit(10)
          .select(
            "username email emailOrPhone role isPremium premiumExpires plan subscriptionPlan membershipRole createdAt lastActive"
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

      const agg = await enrichUserAggregateCounts(
        User,
        Note,
        Reminder,
        (recentUserDocs || []).map((u) => u._id)
      );

      const recentUsers = (recentUserDocs || []).map((u) => {
        const uid = String(u._id);
        const counts = {
          notes: agg.notes.get(uid) || 0,
          reminders: agg.reminders.get(uid) || 0,
          invites: agg.invites.get(uid) || 0
        };
        const activeNow = activeNowFlag(u, ACTIVE_WINDOW_MS);
        return adminUserJson(u, ACTIVE_WINDOW_MS, activeNow, counts);
      });

      res.json({
        stats,
        analytics,
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

  router.get("/users/:id", requireStaffMin(STAFF_RANK.SUPPORT), async (req, res) => {
    try {
      const targetId = req.params.id;
      if (!mongoose.Types.ObjectId.isValid(targetId)) {
        return res.status(400).json({ error: "Invalid user id" });
      }
      const user = await User.findById(targetId)
        .select(
          "username emailOrPhone email isPremium premiumExpires plan subscriptionPlan role membershipRole createdAt lastActive"
        )
        .lean();

      if (!user) return res.status(404).json({ error: "User not found" });

      const agg = await enrichUserAggregateCounts(User, Note, Reminder, [user._id]);
      const uid = String(user._id);
      const counts = {
        notes: agg.notes.get(uid) || 0,
        reminders: agg.reminders.get(uid) || 0,
        invites: agg.invites.get(uid) || 0
      };
      const activeNow = activeNowFlag(user, ACTIVE_WINDOW_MS);
      res.json({ user: adminUserJson(user, ACTIVE_WINDOW_MS, activeNow, counts) });
    } catch {
      res.status(500).json({ error: "Failed to load user" });
    }
  });

  router.get("/users", requireStaffMin(STAFF_RANK.SUPPORT), async (req, res) => {
    try {
      const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
      const limitRaw = parseInt(String(req.query.limit || "25"), 10) || 25;
      const limit = Math.min(100, Math.max(5, limitRaw));
      const search = escapeMongoRegex(req.query.search || "");
      const tier = String(req.query.tier || "all").toLowerCase();

      const parts = [];
      if (search.trim()) {
        const rx = new RegExp(search, "i");
        parts.push({
          $or: [{ username: rx }, { emailOrPhone: rx }, { email: rx }]
        });
      }
      if (tier === "premium") parts.push(PREMIUM_USER_QUERY);

      /** @type {Record<string, unknown>} */
      const match = parts.length === 0 ? {} : parts.length === 1 ? parts[0] : { $and: parts };

      const [total, userSlice] = await Promise.all([
        User.countDocuments(match),
        User.find(match)
          .select(
            "username emailOrPhone email isPremium premiumExpires plan subscriptionPlan role membershipRole createdAt lastActive"
          )
          .sort({ createdAt: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .lean()
          .exec()
      ]);

      const ids = (userSlice || []).map((u) => u._id);
      const agg = await enrichUserAggregateCounts(User, Note, Reminder, ids);

      const users = (userSlice || []).map((u) => {
        const uid = String(u._id);
        const counts = {
          notes: agg.notes.get(uid) || 0,
          reminders: agg.reminders.get(uid) || 0,
          invites: agg.invites.get(uid) || 0
        };
        const activeNow = activeNowFlag(u, ACTIVE_WINDOW_MS);
        return adminUserJson(u, ACTIVE_WINDOW_MS, activeNow, counts);
      });

      const totalPages = Math.max(1, Math.ceil(total / limit));

      res.json({
        users,
        page,
        limit,
        total,
        totalPages
      });
    } catch (err) {
      console.error("[admin/users]", err);
      res.status(500).json({ error: "Failed to list users" });
    }
  });

  router.delete("/users/:id", requireStaffMin(STAFF_RANK.ADMIN), async (req, res) => {
    try {
      const targetId = req.params.id;
      if (!mongoose.Types.ObjectId.isValid(targetId)) {
        return res.status(400).json({ error: "Invalid user id" });
      }
      if (String(targetId) === String(req.userId)) {
        return res.status(400).json({ error: "You cannot delete your own account here" });
      }

      const target = await User.findById(targetId).select("role").lean();
      if (!target) return res.status(404).json({ error: "User not found" });
      if (target.role === "admin") {
        const others = await User.countDocuments({
          role: "admin",
          _id: { $ne: new mongoose.Types.ObjectId(targetId) }
        });
        if (others < 1) {
          return res.status(400).json({ error: "Cannot delete the last admin account" });
        }
      }

      await Note.deleteMany({ userId: targetId });
      await Reminder.deleteMany({ userId: targetId });
      await User.findByIdAndDelete(targetId);
      res.json({ success: true });
    } catch {
      res.status(500).json({ error: "Failed to delete user" });
    }
  });

  /** Admin-only: change staff panel role (user / admin / moderator / support). */
  router.patch("/users/:id/staff-role", requireStaffMin(STAFF_RANK.ADMIN), async (req, res) => {
    try {
      const targetId = req.params.id;
      if (!mongoose.Types.ObjectId.isValid(targetId)) {
        return res.status(400).json({ error: "Invalid user id" });
      }
      if (String(targetId) === String(req.userId)) {
        return res.status(400).json({ error: "You cannot change your own staff role here" });
      }

      const nextRole = String((req.body && req.body.staffRole) || "").toLowerCase().trim();
      if (!STAFF_ASSIGNABLE_ROLES.includes(nextRole)) {
        return res.status(400).json({ error: "staffRole must be user | admin | moderator | support" });
      }

      const target = await User.findById(targetId).select("role").lean();
      if (!target) return res.status(404).json({ error: "User not found" });

      if (target.role === "admin" && nextRole !== "admin") {
        const others = await User.countDocuments({
          role: "admin",
          _id: { $ne: new mongoose.Types.ObjectId(targetId) }
        });
        if (others < 1) {
          return res.status(400).json({ error: "Cannot demote the last admin" });
        }
      }

      await User.findByIdAndUpdate(targetId, { $set: { role: nextRole } }, { new: true });

      const user = await User.findById(targetId)
        .select(
          "username emailOrPhone email isPremium premiumExpires plan subscriptionPlan role membershipRole createdAt lastActive"
        )
        .lean();

      if (!user) return res.status(404).json({ error: "User not found" });

      const agg = await enrichUserAggregateCounts(User, Note, Reminder, [user._id]);
      const uid = String(user._id);
      const counts = {
        notes: agg.notes.get(uid) || 0,
        reminders: agg.reminders.get(uid) || 0,
        invites: agg.invites.get(uid) || 0
      };
      res.json({ user: adminUserJson(user, ACTIVE_WINDOW_MS, undefined, counts) });
    } catch {
      res.status(500).json({ error: "Failed to update staff role" });
    }
  });

  router.post("/users/:id/grant-premium", requireStaffMin(STAFF_RANK.MODERATOR), async (req, res) => {
    try {
      const targetId = req.params.id;
      if (!mongoose.Types.ObjectId.isValid(targetId)) {
        return res.status(400).json({ error: "Invalid user id" });
      }

      const body = req.body || {};
      const preset = typeof body.preset === "string" ? body.preset.toLowerCase().trim() : "";
      /** @type {Record<string, number>} */
      const monthsByPreset = { "1m": 1, "3m": 3, "6m": 6 };

      if (preset === "lifetime") {
        await adminGrantPremiumLifetime(User, targetId);
      } else if (monthsByPreset[preset] != null) {
        await adminGrantPremiumMonths(User, targetId, monthsByPreset[preset]);
      } else if (typeof body.months === "number" || typeof body.months === "string") {
        await adminGrantPremiumMonths(User, targetId, Number(body.months));
      } else {
        return res.status(400).json({ error: "Body preset must be 1m | 3m | 6m | lifetime, or numeric months" });
      }

      const user = await User.findById(targetId)
        .select(
          "username emailOrPhone email isPremium premiumExpires plan subscriptionPlan membershipRole role createdAt lastActive"
        )
        .lean();

      if (!user) return res.status(404).json({ error: "User not found" });

      const agg = await enrichUserAggregateCounts(User, Note, Reminder, [user._id]);
      const uid = String(user._id);
      const counts = {
        notes: agg.notes.get(uid) || 0,
        reminders: agg.reminders.get(uid) || 0,
        invites: agg.invites.get(uid) || 0
      };
      res.json({ user: adminUserJson(user, ACTIVE_WINDOW_MS, undefined, counts) });
    } catch (err) {
      if (err && (err.message === "Invalid months" || err.message === "User not found")) {
        return res.status(400).json({ error: err.message });
      }
      res.status(500).json({ error: "Failed to grant premium" });
    }
  });

  /** Set product plan (alias for PATCH /users/:id/plan). */
  router.patch("/users/:id/subscription", requireStaffMin(STAFF_RANK.MODERATOR), async (req, res) => {
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
          "username emailOrPhone email isPremium premiumExpires plan subscriptionPlan role membershipRole createdAt lastActive"
        )
        .lean();

      if (!user) return res.status(404).json({ error: "User not found" });
      const agg = await enrichUserAggregateCounts(User, Note, Reminder, [user._id]);
      const uid = String(user._id);
      const counts = {
        notes: agg.notes.get(uid) || 0,
        reminders: agg.reminders.get(uid) || 0,
        invites: agg.invites.get(uid) || 0
      };
      res.json({ user: adminUserJson(user, ACTIVE_WINDOW_MS, undefined, counts) });
    } catch (err) {
      if (err && err.message === "Invalid plan") {
        return res.status(400).json({ error: err.message });
      }
      res.status(500).json({ error: "Failed to update subscription plan" });
    }
  });

  /** Canonical admin endpoint: set plan (free | standard | premium). */
  router.patch("/users/:id/plan", requireStaffMin(STAFF_RANK.MODERATOR), async (req, res) => {
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
          "username emailOrPhone email isPremium premiumExpires plan subscriptionPlan role membershipRole createdAt lastActive"
        )
        .lean();

      if (!user) return res.status(404).json({ error: "User not found" });
      const agg = await enrichUserAggregateCounts(User, Note, Reminder, [user._id]);
      const uid = String(user._id);
      const counts = {
        notes: agg.notes.get(uid) || 0,
        reminders: agg.reminders.get(uid) || 0,
        invites: agg.invites.get(uid) || 0
      };
      res.json({ user: adminUserJson(user, ACTIVE_WINDOW_MS, undefined, counts) });
    } catch (err) {
      if (err && err.message === "Invalid plan") {
        return res.status(400).json({ error: err.message });
      }
      res.status(500).json({ error: "Failed to update plan" });
    }
  });

  router.patch("/users/:id/premium", requireStaffMin(STAFF_RANK.MODERATOR), async (req, res) => {
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
          "username emailOrPhone email isPremium premiumExpires plan subscriptionPlan role membershipRole createdAt lastActive"
        )
        .lean();

      if (!user) return res.status(404).json({ error: "User not found" });
      const agg = await enrichUserAggregateCounts(User, Note, Reminder, [user._id]);
      const uid = String(user._id);
      const counts = {
        notes: agg.notes.get(uid) || 0,
        reminders: agg.reminders.get(uid) || 0,
        invites: agg.invites.get(uid) || 0
      };
      res.json({ user: adminUserJson(user, ACTIVE_WINDOW_MS, undefined, counts) });
    } catch {
      res.status(500).json({ error: "Failed to update premium" });
    }
  });

  router.patch("/users/:id/membership-role", requireStaffMin(STAFF_RANK.MODERATOR), async (req, res) => {
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
          "username emailOrPhone email isPremium premiumExpires plan subscriptionPlan role membershipRole createdAt lastActive"
        )
        .lean();

      if (!user) return res.status(404).json({ error: "User not found" });
      const agg = await enrichUserAggregateCounts(User, Note, Reminder, [user._id]);
      const uid = String(user._id);
      const counts = {
        notes: agg.notes.get(uid) || 0,
        reminders: agg.reminders.get(uid) || 0,
        invites: agg.invites.get(uid) || 0
      };
      res.json({ user: adminUserJson(user, ACTIVE_WINDOW_MS, undefined, counts) });
    } catch (err) {
      if (err && err.message === "Invalid plan") {
        return res.status(400).json({ error: err.message });
      }
      res.status(500).json({ error: "Failed to update role" });
    }
  });

  router.get("/messages", requireStaffMin(STAFF_RANK.SUPPORT), async (_req, res) => {
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

  router.delete("/messages/:id", requireStaffMin(STAFF_RANK.MODERATOR), async (req, res) => {
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

  router.get("/config/discord", requireStaffMin(STAFF_RANK.SUPPORT), async (_req, res) => {
    try {
      res.set("Cache-Control", "no-store, max-age=0");
      const doc = await AppConfig.findOne({ key: "main" })
        .select("discordInviteUrl discordUpdatesCount tiktokUrl youtubeUrl supportEmail")
        .lean();
      return res.json({
        discordInviteUrl: doc && doc.discordInviteUrl ? String(doc.discordInviteUrl) : "",
        discordUpdatesCount: Math.max(0, Number((doc && doc.discordUpdatesCount) || 0)),
        tiktokUrl: doc && doc.tiktokUrl ? String(doc.tiktokUrl) : "",
        youtubeUrl: doc && doc.youtubeUrl ? String(doc.youtubeUrl) : "",
        supportEmail: doc && doc.supportEmail ? String(doc.supportEmail).trim().toLowerCase() : ""
      });
    } catch {
      return res.status(500).json({ error: "Failed to load Discord config" });
    }
  });

  router.put("/config/discord", requireStaffMin(STAFF_RANK.SUPPORT), async (req, res) => {
    try {
      const prependHttp = (raw) => {
        const s = String(raw || "").trim();
        if (!s) return "";
        return /^https?:\/\//i.test(s) ? s : `https://${s.replace(/^\/+/, "")}`;
      };
      const b = req.body && typeof req.body === "object" ? req.body : {};
      const rawUrl = prependHttp(String(b.discordInviteUrl ?? "").trim());
      const rawTiktok = prependHttp(String((b.tiktokUrl ?? b.tikTokUrl ?? "") || "").trim());
      const rawYoutube = prependHttp(String((b.youtubeUrl ?? b.youtubeURL ?? "") || "").trim());
      const rawSupport = String((b.supportEmail ?? b.contactEmail ?? "") || "")
        .trim()
        .replace(/^mailto:/i, "")
        .trim()
        .toLowerCase();
      const updatesCountRaw = b.discordUpdatesCount;
      if (rawUrl && !/^https?:\/\//i.test(rawUrl)) {
        return res.status(400).json({ error: "Discord URL must start with http:// or https://" });
      }
      if (rawTiktok && !/^https?:\/\//i.test(rawTiktok)) {
        return res.status(400).json({ error: "TikTok URL must start with http:// or https://" });
      }
      if (rawYoutube && !/^https?:\/\//i.test(rawYoutube)) {
        return res.status(400).json({ error: "YouTube URL must start with http:// or https://" });
      }
      if (rawSupport && rawSupport.length > 320) {
        return res.status(400).json({ error: "Support email is too long" });
      }
      if (rawSupport && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawSupport)) {
        return res.status(400).json({ error: "Support email must be a valid address (e.g. you@gmail.com)" });
      }
      const discordUpdatesCount = Number.isFinite(Number(updatesCountRaw))
        ? Math.max(0, Math.floor(Number(updatesCountRaw)))
        : 0;
      await AppConfig.findOneAndUpdate(
        { key: "main" },
        {
          $set: {
            key: "main",
            discordInviteUrl: rawUrl,
            discordUpdatesCount,
            tiktokUrl: rawTiktok,
            youtubeUrl: rawYoutube,
            supportEmail: rawSupport
          }
        },
        { upsert: true, new: false }
      );
      /** Read-after-write mirrors DB exactly (Discord + TikTok + YouTube). */
      const fresh =
        (await AppConfig.findOne({ key: "main" })
          .select("discordInviteUrl discordUpdatesCount tiktokUrl youtubeUrl supportEmail")
          .lean()) ||
        null;
      return res.json({
        success: true,
        discordInviteUrl: fresh && fresh.discordInviteUrl ? String(fresh.discordInviteUrl) : "",
        discordUpdatesCount: Math.max(0, Number((fresh && fresh.discordUpdatesCount) || 0)),
        tiktokUrl: fresh && fresh.tiktokUrl ? String(fresh.tiktokUrl) : "",
        youtubeUrl: fresh && fresh.youtubeUrl ? String(fresh.youtubeUrl) : "",
        supportEmail: fresh && fresh.supportEmail ? String(fresh.supportEmail).trim().toLowerCase() : ""
      });
    } catch {
      return res.status(500).json({ error: "Failed to save Discord config" });
    }
  });

  return router;
}

module.exports = { createAdminRouter };
