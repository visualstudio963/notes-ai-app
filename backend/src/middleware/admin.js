const ALLOWED_STAFF_PANEL_ROLES = new Set(["admin", "moderator", "support"]);

const STAFF_RANK = {
  SUPPORT: 1,
  MODERATOR: 2,
  ADMIN: 3
};

const roleToRank = {
  support: STAFF_RANK.SUPPORT,
  moderator: STAFF_RANK.MODERATOR,
  admin: STAFF_RANK.ADMIN
};

/** Gate: Bearer must belong to admin / moderator / support. Sets req.staffRole, req.staffRank, req.adminUser */
function createAdminMiddleware(User) {
  return async function adminMiddleware(req, res, next) {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    try {
      const user = await User.findById(req.userId).select("role username").lean();
      if (!user) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const role = typeof user.role === "string" ? user.role.toLowerCase().trim() : "user";
      if (!ALLOWED_STAFF_PANEL_ROLES.has(role)) {
        return res.status(403).json({ error: "Staff access denied" });
      }
      req.staffRole = role;
      req.staffRank = roleToRank[role] || 0;
      req.adminUser = user;
      next();
    } catch {
      res.status(500).json({ error: "Server error" });
    }
  };
}

/** @param {number} minRank one of {@link STAFF_RANK} values */
function requireStaffMin(minRank) {
  return function requireStaffMinInner(req, res, next) {
    if ((req.staffRank || 0) >= minRank) {
      next();
      return;
    }
    res.status(403).json({ error: "Insufficient permissions" });
  };
}

module.exports = {
  createAdminMiddleware,
  requireStaffMin,
  STAFF_RANK
};
