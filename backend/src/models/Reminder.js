const mongoose = require("mongoose");

const reminderSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    noteId: { type: mongoose.Schema.Types.ObjectId, ref: "Note" },
    category: { type: String },
    type: { type: String, enum: ["note_reminder", "ai_memory"], default: "note_reminder" },
    aiMessage: { type: String },
    parsedDate: { type: Date },
    notificationType: { type: String, enum: ["web", "whatsapp"], default: "web" },
    message: { type: String, required: true },
    time: { type: Date, required: true },
    phone: { type: String },
    action: { type: String, enum: ["reminder", "whatsapp"], default: "reminder" },
    sent: { type: Boolean, default: false },
    sentAt: { type: Date },
    status: { type: String, enum: ["pending", "sent", "failed"], default: "pending" }
  },
  { timestamps: true }
);

reminderSchema.index({ time: 1, sent: 1, status: 1 });

module.exports = mongoose.model("Reminder", reminderSchema);
