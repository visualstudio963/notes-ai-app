const mongoose = require("mongoose");

const appConfigSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: "main" },
    discordInviteUrl: { type: String, default: "" },
    discordUpdatesCount: { type: Number, default: 0 },
    tiktokUrl: { type: String, default: "" },
    youtubeUrl: { type: String, default: "" }
  },
  { timestamps: true }
);

module.exports = mongoose.model("AppConfig", appConfigSchema);
