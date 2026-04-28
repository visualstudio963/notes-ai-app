/**
 * Updates User.lastActive for valid JWTs (throttled per user to limit writes).
 */
function createTouchLastActiveMiddleware({ User, jwt, jwtSecret, minIntervalMs = 60_000 }) {
  const lastTouch = new Map();

  return function touchLastActive(req, res, next) {
    next();

    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      return;
    }
    const token = header.slice(7);
    let id;
    try {
      const payload = jwt.verify(token, jwtSecret);
      id = payload && payload.id ? String(payload.id) : null;
    } catch {
      return;
    }
    if (!id) return;

    const now = Date.now();
    if (now - (lastTouch.get(id) || 0) < minIntervalMs) {
      return;
    }
    if (lastTouch.size > 8000) {
      lastTouch.clear();
    }
    lastTouch.set(id, now);
    User.updateOne({ _id: id }, { $set: { lastActive: new Date() } })
      .then(() => {})
      .catch(() => {});
  };
}

module.exports = { createTouchLastActiveMiddleware };
