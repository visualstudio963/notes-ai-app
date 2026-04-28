function createAdminMiddleware(User) {
  return async function adminMiddleware(req, res, next) {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    try {
      const user = await User.findById(req.userId).select("role username");
      if (!user) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const role = user.role || "user";
      if (role !== "admin") {
        return res.status(403).json({ error: "Access denied" });
      }
      req.adminUser = user;
      next();
    } catch {
      res.status(500).json({ error: "Server error" });
    }
  };
}

module.exports = { createAdminMiddleware };
