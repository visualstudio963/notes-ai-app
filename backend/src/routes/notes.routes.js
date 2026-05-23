const express = require("express");
const mongoose = require("mongoose");
const {
  hasActivePremium,
  hasScanCamAccess,
  hasStandardTierAccess,
  LEAN_USER_SUBSCRIPTION_TIER_FIELDS
} = require("../features/premium/subscriptionService");

const ALLOWED_NOTE_CATEGORIES = ["shtepia", "puna", "shkolla", "scan_cam"];

/**
 * @param {object | null | undefined} body
 * @returns {string}
 */
function pickTitleFromBody(body) {
  if (!body || typeof body !== "object") return "";
  if (body.title != null) return String(body.title).trim();
  if (body.Title != null) return String(body.Title).trim();
  return "";
}

/**
 * @param {object | null | undefined} body
 * @returns {string[] | undefined} undefined if field omitted
 */
function pickTagsFromBody(body) {
  if (!body || typeof body !== "object" || !Object.prototype.hasOwnProperty.call(body, "tags")) {
    return undefined;
  }
  const raw = body.tags;
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const t = String(item ?? "")
      .trim()
      .slice(0, 48);
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= 24) break;
  }
  return out;
}

/**
 * @param {object | null | undefined} body
 * @returns {Date | null | undefined} undefined = omit; null = clear
 */
function pickNoteDateFromBody(body) {
  if (!body || typeof body !== "object" || !Object.prototype.hasOwnProperty.call(body, "noteDate")) {
    return undefined;
  }
  const v = body.noteDate;
  if (v === null || v === "") return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

/**
 * Stable JSON shape for clients (always includes `title` string).
 * @param {import("mongoose").Document | Record<string, unknown> | null | undefined} n
 */
function serializeNote(n) {
  const o = n && typeof n.toObject === "function" ? n.toObject() : n;
  if (!o) return null;
  const raw = o.title;
  const title = raw != null && raw !== undefined ? String(raw).trim() : "";
  const tags = Array.isArray(o.tags) ? o.tags : [];
  let noteDateOut = null;
  if (o.noteDate) {
    try {
      noteDateOut = new Date(o.noteDate).toISOString().slice(0, 10);
    } catch {
      noteDateOut = null;
    }
  }

  return {
    _id: o._id,
    userId: o.userId,
    category: o.category,
    text: o.text,
    title,
    tags,
    noteDate: noteDateOut,
    createdAt: o.createdAt
  };
}

function createNotesRouter({ User, Note, authMiddleware, getIo }) {
  const router = express.Router();

  router.get("/notes/:category", authMiddleware, async (req, res) => {
    try {
      const category = req.params.category.toLowerCase();
      const notes = await Note.find({ userId: req.userId, category }).sort({ createdAt: -1 }).lean();
      res.json({ notes: notes.map((doc) => serializeNote(doc)) });
    } catch {
      res.status(500).json({ error: "Failed to load notes" });
    }
  });

  router.get("/notes", authMiddleware, async (req, res) => {
    try {
      if (String(req.query.count || "") === "1") {
        const count = await Note.countDocuments({ userId: req.userId }).exec();
        return res.json({ count });
      }
      const notes = await Note.find({ userId: req.userId }).sort({ category: 1, createdAt: -1 }).lean();
      res.json({ notes: notes.map((doc) => serializeNote(doc)) });
    } catch {
      res.status(500).json({ error: "Failed to load notes" });
    }
  });

  router.post("/notes", authMiddleware, async (req, res) => {
    try {
      const { category, text } = req.body || {};
      const textVal = text != null ? String(text).trim() : "";
      if (!category || !textVal) {
        return res.status(400).json({ error: "Category and text are required" });
      }
      const catKey = String(category).toLowerCase();
      if (!ALLOWED_NOTE_CATEGORIES.includes(catKey)) {
        return res.status(400).json({ error: "Invalid category" });
      }
      const user = await User.findById(req.userId).select(LEAN_USER_SUBSCRIPTION_TIER_FIELDS).lean();
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      if (!hasStandardTierAccess(user)) {
        const freeNotesCount = await Note.countDocuments({ userId: req.userId }).exec();
        if (freeNotesCount >= 5) {
          return res.status(403).json({
            error: "Free plan allows up to 5 notes. Upgrade to add more.",
            code: "FREE_NOTES_LIMIT"
          });
        }
      }
      if (catKey === "scan_cam") {
        if (!hasScanCamAccess(user)) {
          return res.status(403).json({
            error: "Scan Cam requires Standard or Premium.",
            code: "SCAN_CAM_PLAN"
          });
        }
      }
      const titleVal = pickTitleFromBody(req.body);
      const tagsVal = pickTagsFromBody(req.body);
      const noteDateVal = pickNoteDateFromBody(req.body);

      const createPayload = { userId: req.userId, category: catKey, text: textVal, title: titleVal };
      if (tagsVal !== undefined) createPayload.tags = tagsVal;
      if (noteDateVal !== undefined) createPayload.noteDate = noteDateVal;

      const note = await Note.create(createPayload);
      const out = serializeNote(note);
      getIo().to(String(req.userId)).emit("noteCreated", { note: out });

      res.status(201).json({ note: out });
    } catch {
      res.status(500).json({ error: "Failed to create note" });
    }
  });

  router.put("/notes/:id", authMiddleware, async (req, res) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid note id" });
    }
    try {
      const body = req.body || {};
      const { text } = body;
      const textVal = text != null ? String(text).trim() : "";
      if (!textVal) {
        return res.status(400).json({ error: "Text is required" });
      }
      const update = { text: textVal };
      if (Object.prototype.hasOwnProperty.call(body, "title") || Object.prototype.hasOwnProperty.call(body, "Title")) {
        update.title = pickTitleFromBody(body);
      }
      const tagsUp = pickTagsFromBody(body);
      if (tagsUp !== undefined) {
        update.tags = tagsUp;
      }
      const noteDateUp = pickNoteDateFromBody(body);
      if (noteDateUp !== undefined) {
        update.noteDate = noteDateUp;
      }

      const note = await Note.findOneAndUpdate(
        { _id: req.params.id, userId: req.userId },
        { $set: update },
        { new: true }
      );

      if (!note) {
        return res.status(404).json({ error: "Note not found" });
      }

      const out = serializeNote(note);
      getIo().to(String(req.userId)).emit("noteUpdated", { note: out });
      res.json({ note: out });
    } catch {
      res.status(500).json({ error: "Failed to update note" });
    }
  });

  router.delete("/notes/:id", authMiddleware, async (req, res) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid note id" });
    }
    try {
      const note = await Note.findOneAndDelete({ _id: req.params.id, userId: req.userId });
      if (!note) {
        return res.status(404).json({ error: "Note not found" });
      }
      getIo().to(String(req.userId)).emit("noteDeleted", { noteId: req.params.id });
      res.json({ success: true });
    } catch {
      res.status(500).json({ error: "Failed to delete note" });
    }
  });

  return router;
}

module.exports = { createNotesRouter };
