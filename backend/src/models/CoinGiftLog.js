const mongoose = require("mongoose");

const coinGiftLogSchema = new mongoose.Schema(
  {
    recipientUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    giftedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    amount: { type: Number, required: true, min: 1 },
    balanceBefore: { type: Number, required: true, min: 0 },
    balanceAfter: { type: Number, required: true, min: 0 },
    reason: { type: String, default: "", trim: true, maxlength: 300 },
    source: { type: String, enum: ["admin_gift"], default: "admin_gift" }
  },
  { timestamps: true }
);

coinGiftLogSchema.index({ recipientUserId: 1, createdAt: -1 });
coinGiftLogSchema.index({ giftedByUserId: 1, createdAt: -1 });

module.exports = mongoose.model("CoinGiftLog", coinGiftLogSchema);
