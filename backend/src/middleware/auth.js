function createAuthMiddleware(jwt, jwtSecret) {
  return function authMiddleware(req, res, next) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Authorization token required" });
    }
    const token = header.split(" ")[1];
    try {
      const payload = jwt.verify(token, jwtSecret);
      req.userId = payload.id;
      next();
    } catch {
      return res.status(401).json({ error: "Invalid token" });
    }
  };
}

module.exports = { createAuthMiddleware };
