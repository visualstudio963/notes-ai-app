const crypto = require("crypto");
const {
  COIN_CAP,
  STANDARD_MONTHLY_COIN_COST,
  STANDARD_MONTHLY_DURATION_MS,
  STANDARD_YEARLY_COIN_COST,
  STANDARD_YEARLY_DURATION_MS,
  STANDARD_COIN_COST,
  DAILY_STREAK_REWARDS,
  VIDEO_REWARD,
  VIDEO_DAILY_MAX,
  INVITE_REWARD,
  INVITE_MONTHLY_CAP,
  STANDARD_TIER_EARN_MULTIPLIER
} = require("./coinConstants");
const {
  getUserLifecycle,
  getUserPlan,
  getStandardPlanKind,
  hasStandardAccess,
  resolveStandardExpiresAt,
  grantStandardAccess
} = require("../premium/subscriptionService");

function utcTodayString(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function utcYesterdayString() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return utcTodayString(d);
}

function clampCoins(n) {
  const x = Math.max(0, Math.floor(Number(n) || 0));
  return Math.min(COIN_CAP, x);
}

function earningMultiplierForUser(user) {
  if (!user) return 1;
  const life = getUserLifecycle(user);
  if (life === "standard") return STANDARD_TIER_EARN_MULTIPLIER;
  return 1;
}

function scaledReward(base, user) {
  const m = earningMultiplierForUser(user);
  return Math.max(0, Math.floor(base * m));
}

function randomReferralCode() {
  return crypto.randomBytes(6).toString("hex").slice(0, 10).toUpperCase();
}

/** Invite code can be attached only shortly after account creation. */
const INVITE_BIND_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Ensures referralCode exists (lazy backfill).
 * @param {import("mongoose").Model} User
 */
async function ensureReferralCode(User, userDoc) {
  const existingA = userDoc && userDoc.referralCode ? String(userDoc.referralCode).trim() : "";
  const existingB = userDoc && userDoc.inviteCode ? String(userDoc.inviteCode).trim() : "";
  const existing = existingA || existingB;
  if (existing) {
    const normalized = existing.toUpperCase();
    if (!existingA || !existingB || existingA !== existingB) {
      return User.findByIdAndUpdate(
        userDoc._id,
        { $set: { referralCode: normalized, inviteCode: normalized } },
        { new: true, runValidators: false }
      );
    }
    return userDoc;
  }
  for (let i = 0; i < 8; i += 1) {
    const code = randomReferralCode();
    try {
      return await User.findByIdAndUpdate(
        userDoc._id,
        { $set: { referralCode: code, inviteCode: code } },
        { new: true, runValidators: false }
      );
    } catch (e) {
      if (e && e.code === 11000) continue;
      throw e;
    }
  }
  throw new Error("Could not allocate referral code");
}

function trialDaysRemainingMs(user, nowMs = Date.now()) {
  const t = user && user.trialEndsAt ? new Date(user.trialEndsAt).getTime() : 0;
  if (!Number.isFinite(t) || t <= nowMs) return null;
  return Math.ceil((t - nowMs) / 86400000);
}

async function finalizeInviteBonus(User, inviteeDoc) {
  if (!inviteeDoc || !inviteeDoc.referredByUserId) return null;
  if (inviteeDoc.inviteBonusCreditedAt || inviteeDoc.referralRewarded === true) return null;

  const inviterOid = inviteeDoc.referredByUserId;
  const now = new Date();
  const lockedInvitee = await User.findOneAndUpdate(
    {
      _id: inviteeDoc._id,
      referredByUserId: { $exists: true, $ne: null },
      inviteBonusCreditedAt: null,
      referralRewarded: { $ne: true }
    },
    { $set: { inviteBonusCreditedAt: now, referralRewarded: true } },
    { new: true, runValidators: false }
  );
  if (!lockedInvitee) return null;

  if (String(inviterOid) === String(inviteeDoc._id)) {
    await User.updateOne(
      { _id: inviteeDoc._id },
      { $set: { referredByUserId: null, invitedBy: null } },
      { runValidators: false }
    );
    return null;
  }

  const inviter = await User.findById(inviterOid);
  if (!inviter) return null;

  const ym = utcTodayString().slice(0, 7);
  let monthCount = Number(inviter.inviteFriendMonthCount || 0) || 0;
  if (String(inviter.inviteFriendMonthYm || "") !== ym) {
    monthCount = 0;
    inviter.inviteFriendMonthYm = ym;
  }
  if (monthCount >= INVITE_MONTHLY_CAP) {
    return { capped: true };
  }

  const inviterBalance = Number(inviter.coins) || 0;
  if (inviterBalance >= COIN_CAP) {
    return { capped: true, walletFull: true };
  }
  const reward = INVITE_REWARD;
  const actualReward = Math.min(reward, COIN_CAP - inviterBalance);
  inviter.inviteFriendMonthYm = ym;
  inviter.inviteFriendMonthCount = monthCount + 1;
  inviter.coins = clampCoins(inviterBalance + actualReward);
  await inviter.save();

  return { rewarded: reward };
}

async function finalizeInviteBonusById(User, inviteeId) {
  const invitee = await User.findById(inviteeId);
  if (!invitee) return null;
  return finalizeInviteBonus(User, invitee);
}

async function bindReferralCode(User, inviteeId, rawCode) {
  const normalized = String(rawCode || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (normalized.length < 4) {
    const err = new Error("Invalid invite code.");
    err.statusCode = 400;
    throw err;
  }

  let invitee = await User.findById(inviteeId);
  if (!invitee) {
    const err = new Error("User not found.");
    err.statusCode = 404;
    throw err;
  }

  invitee = await ensureReferralCode(User, invitee);

  const createdMs = invitee && invitee.createdAt ? new Date(invitee.createdAt).getTime() : 0;
  const nowMs = Date.now();
  const isNewAccountWindow = Number.isFinite(createdMs) && nowMs - createdMs >= 0 && nowMs - createdMs <= INVITE_BIND_MAX_AGE_MS;
  if (!isNewAccountWindow) {
    const err = new Error("Invite code can only be applied to a new account.");
    err.statusCode = 409;
    throw err;
  }

  if (invitee.referredByUserId) {
    await finalizeInviteBonus(User, invitee);
    return User.findById(invitee._id).lean();
  }

  const inviter = await User.findOne({ $or: [{ referralCode: normalized }, { inviteCode: normalized }] }).select(
    "_id referralCode inviteCode coins"
  );
  if (!inviter || String(inviter._id) === String(invitee._id)) {
    const err = new Error("Invalid invite code.");
    err.statusCode = 400;
    throw err;
  }

  invitee.referredByUserId = inviter._id;
  invitee.invitedBy = inviter._id;
  await invitee.save();

  await finalizeInviteBonus(User, invitee);
  return User.findById(invitee._id).lean();
}

async function claimDailyLogin(User, userId) {
  const userLean = await User.findById(userId).lean();
  if (!userLean) {
    const err = new Error("User not found");
    err.statusCode = 404;
    throw err;
  }

  const today = utcTodayString();
  const last = userLean.dailyLoginUtcDate ? String(userLean.dailyLoginUtcDate) : "";

  if (last === today) {
    const err = new Error("Daily reward already claimed today.");
    err.statusCode = 409;
    err.code = "DAILY_CLAIMED";
    throw err;
  }

  let nextIdx = Number(userLean.loginStreakNextIndex) || 1;
  if (nextIdx < 1 || nextIdx > 7) nextIdx = 1;

  if (last && last !== utcYesterdayString()) {
    nextIdx = 1;
  }

  const balanceBefore = Number(userLean.coins) || 0;
  if (balanceBefore >= COIN_CAP) {
    const err = new Error("Wallet is full. Spend coins on Standard before earning more.");
    err.statusCode = 400;
    err.code = "WALLET_FULL";
    throw err;
  }

  const base = DAILY_STREAK_REWARDS[nextIdx - 1] ?? DAILY_STREAK_REWARDS[0];
  const gained = scaledReward(base, userLean);
  const actualGain = Math.min(gained, COIN_CAP - balanceBefore);
  if (actualGain < 1) {
    const err = new Error("Wallet is full. Spend coins on Standard before earning more.");
    err.statusCode = 400;
    err.code = "WALLET_FULL";
    throw err;
  }
  const nextAfter = nextIdx >= 7 ? 1 : nextIdx + 1;
  const newCoins = clampCoins(balanceBefore + actualGain);

  /* Atomic $set only — skips full-document Mongoose validation (legacy users without email rows). */
  const updated = await User.findOneAndUpdate(
    { _id: userId, dailyLoginUtcDate: { $ne: today } },
    {
      $set: {
        dailyLoginUtcDate: today,
        loginStreakNextIndex: nextAfter,
        coins: newCoins
      }
    },
    { new: true, runValidators: false, lean: true }
  );

  if (!updated) {
    const check = await User.findById(userId).select("dailyLoginUtcDate").lean();
    if (!check) {
      const err = new Error("User not found");
      err.statusCode = 404;
      throw err;
    }
    if (String(check.dailyLoginUtcDate || "") === today) {
      const err = new Error("Daily reward already claimed today.");
      err.statusCode = 409;
      err.code = "DAILY_CLAIMED";
      throw err;
    }
    const err = new Error("Daily reward failed.");
    err.statusCode = 500;
    throw err;
  }

  return updated;
}

async function claimVideoReward(User, userId) {
  const userLean = await User.findById(userId).lean();
  if (!userLean) {
    const err = new Error("User not found");
    err.statusCode = 404;
    throw err;
  }

  const today = utcTodayString();
  const sameDay = String(userLean.videoRewardUtcDate || "") === today;
  const countToday = sameDay ? Number(userLean.videoRewardCount || 0) || 0 : 0;

  if (countToday >= VIDEO_DAILY_MAX) {
    const err = new Error("Daily video reward limit reached.");
    err.statusCode = 429;
    err.code = "VIDEO_CAP";
    throw err;
  }

  const balance = Number(userLean.coins) || 0;
  if (balance >= COIN_CAP) {
    const err = new Error("Wallet is full. Spend coins on Standard before earning more.");
    err.statusCode = 400;
    err.code = "WALLET_FULL";
    throw err;
  }

  const gained = scaledReward(VIDEO_REWARD, userLean);
  const headroom = COIN_CAP - balance;
  const actualGain = Math.min(gained, headroom);
  if (actualGain < 1) {
    const err = new Error("Wallet is full. Spend coins on Standard before earning more.");
    err.statusCode = 400;
    err.code = "WALLET_FULL";
    throw err;
  }

  const newCoins = clampCoins(balance + actualGain);
  const newCount = countToday + 1;

  const updated = await User.findOneAndUpdate(
    { _id: userId, coins: balance },
    {
      $set: {
        coins: newCoins,
        videoRewardUtcDate: today,
        videoRewardCount: newCount
      }
    },
    { new: true, runValidators: false, lean: true }
  );

  if (!updated) {
    const check = await User.findById(userId).select("videoRewardUtcDate videoRewardCount coins").lean();
    if (!check) {
      const err = new Error("User not found");
      err.statusCode = 404;
      throw err;
    }
    const c2 =
      String(check.videoRewardUtcDate || "") === today ? Number(check.videoRewardCount || 0) || 0 : 0;
    if (c2 >= VIDEO_DAILY_MAX) {
      const err = new Error("Daily video reward limit reached.");
      err.statusCode = 429;
      err.code = "VIDEO_CAP";
      throw err;
    }
    if (Number(check.coins) >= COIN_CAP) {
      const err = new Error("Wallet is full. Spend coins on Standard before earning more.");
      err.statusCode = 400;
      err.code = "WALLET_FULL";
      throw err;
    }
    const err = new Error("Video reward failed.");
    err.statusCode = 500;
    throw err;
  }

  return updated;
}

function resolveCoinRedeemPlan(planRaw) {
  const p = String(planRaw || "monthly")
    .trim()
    .toLowerCase();
  if (p === "yearly" || p === "annual") return "yearly";
  return "monthly";
}

async function redeemStandardWithCoins(User, userId, planRaw) {
  const plan = resolveCoinRedeemPlan(planRaw);
  const cost = plan === "yearly" ? STANDARD_YEARLY_COIN_COST : STANDARD_MONTHLY_COIN_COST;
  const durationMs = plan === "yearly" ? STANDARD_YEARLY_DURATION_MS : STANDARD_MONTHLY_DURATION_MS;
  const daysLabel = plan === "yearly" ? 365 : 30;

  const userLean = await User.findById(userId).lean();
  if (!userLean) {
    const err = new Error("User not found");
    err.statusCode = 404;
    throw err;
  }

  const coins = Number(userLean.coins) || 0;
  if (coins < cost) {
    const err = new Error(`Need ${cost} coins to unlock Standard for ${daysLabel} days.`);
    err.statusCode = 400;
    err.code = "INSUFFICIENT_COINS";
    throw err;
  }

  const nowMs = Date.now();
  let baseMs = nowMs;
  const existing = resolveStandardExpiresAt(userLean);
  if (existing && existing.getTime() > nowMs) {
    baseMs = existing.getTime();
  }
  const expiresAt = new Date(baseMs + durationMs);
  const newCoins = clampCoins(coins - cost);

  const debited = await User.findOneAndUpdate(
    { _id: userId, coins: { $gte: cost } },
    { $set: { coins: newCoins } },
    { new: true, runValidators: false }
  );

  if (!debited) {
    const err = new Error(`Need ${cost} coins to unlock Standard for ${daysLabel} days.`);
    err.statusCode = 400;
    err.code = "INSUFFICIENT_COINS";
    throw err;
  }

  try {
    return await grantStandardAccess(User, userId, {
      source: "coins",
      expiresAt,
      billingCycle: plan
    });
  } catch (err) {
    await User.updateOne({ _id: userId }, { $inc: { coins: cost } }).exec();
    throw err;
  }
}

/**
 * Adds total invited friends + estimated coins from referrals this month (additive fields; safe for older clients).
 * @param {import("mongoose").Model} User
 */
async function enrichCoinsStatusWithInviteStats(User, userLean, basePayload) {
  let inviteFriendsTotal = 0;
  try {
    inviteFriendsTotal = await User.countDocuments({ referredByUserId: userLean._id });
  } catch (_) {
    inviteFriendsTotal = 0;
  }
  const ymNow = utcTodayString().slice(0, 7);
  const monthCount =
    String(userLean.inviteFriendMonthYm || "") === ymNow
      ? Number(userLean.inviteFriendMonthCount || 0) || 0
      : 0;
  return {
    ...basePayload,
    inviteFriendsTotal,
    inviteCoinsEarnedThisMonth: monthCount * INVITE_REWARD
  };
}

/**
 * Best-effort startup/manual backfill for legacy users missing invite code aliases.
 * Safe to run repeatedly; only touches referralCode/inviteCode fields.
 */
async function backfillMissingInviteCodes(User, options = {}) {
  const limit = Math.max(1, Math.min(20000, Number(options.limit) || 5000));
  let scanned = 0;
  let updated = 0;
  const cursor = User.find({
    $or: [
      { referralCode: { $exists: false } },
      { referralCode: "" },
      { inviteCode: { $exists: false } },
      { inviteCode: "" }
    ]
  })
    .select("_id referralCode inviteCode")
    .lean()
    .cursor();
  for await (const u of cursor) {
    scanned += 1;
    if (scanned > limit) break;
    try {
      const doc = await User.findById(u._id);
      if (!doc) continue;
      const beforeA = String(doc.referralCode || "").trim();
      const beforeB = String(doc.inviteCode || "").trim();
      const after = await ensureReferralCode(User, doc);
      const afterA = String((after && after.referralCode) || "").trim();
      const afterB = String((after && after.inviteCode) || "").trim();
      if (afterA && afterB && (afterA !== beforeA || afterB !== beforeB)) {
        updated += 1;
      }
    } catch (_) {
      /* keep going */
    }
  }
  return { scanned, updated, limit };
}

function buildCoinsStatusPayload(userLean) {
  const today = utcTodayString();
  const videoCountToday =
    String(userLean.videoRewardUtcDate || "") === today ? Number(userLean.videoRewardCount || 0) || 0 : 0;
  const lifecycle = getUserLifecycle(userLean);
  const trialDaysLeft = lifecycle === "trial" ? trialDaysRemainingMs(userLean) : null;
  const standardExp = resolveStandardExpiresAt(userLean);

  const dailyClaimedToday = String(userLean.dailyLoginUtcDate || "") === today;

  const nextStreakRewardIndex = Number(userLean.loginStreakNextIndex) || 1;
  let nextDailyBase = DAILY_STREAK_REWARDS[Math.min(7, Math.max(1, nextStreakRewardIndex)) - 1];
  nextDailyBase = scaledReward(nextDailyBase, userLean);
  const streakStepCoins = DAILY_STREAK_REWARDS.map((base) => scaledReward(base, userLean));

  return {
    balance: clampCoins(Number(userLean.coins) || 0),
    cap: COIN_CAP,
    standardCoinCost: STANDARD_MONTHLY_COIN_COST,
    standardMonthlyCoinCost: STANDARD_MONTHLY_COIN_COST,
    standardYearlyCoinCost: STANDARD_YEARLY_COIN_COST,
    standardMonthlyDays: 30,
    standardYearlyDays: 365,
    lifecycle,
    tier: getUserPlan(userLean),
    planKind: getStandardPlanKind(userLean),
    billingCycle: userLean.billingCycle === "yearly" ? "yearly" : "monthly",
    trialEndsAt: userLean.trialEndsAt ? new Date(userLean.trialEndsAt).toISOString() : null,
    trialDaysTotal: 14,
    standardActive: hasStandardAccess(userLean),
    standardExpiresAt: standardExp ? standardExp.toISOString() : null,
    standardSource: userLean.standardSource || null,
    trialDaysRemaining: trialDaysLeft,
    standardCoinExpiresAt: userLean.standardCoinExpiresAt
      ? new Date(userLean.standardCoinExpiresAt).toISOString()
      : null,
    dailyLogin: {
      claimedToday: dailyClaimedToday,
      nextStreakIndex: Math.min(7, Math.max(1, nextStreakRewardIndex)),
      nextRewardCoins: nextDailyBase,
      streakStepCoins
    },
    videoRewards: {
      passive: false,
      countToday: videoCountToday,
      maxToday: VIDEO_DAILY_MAX,
      rewardEach: scaledReward(VIDEO_REWARD, userLean),
      dailyCoinCap: VIDEO_REWARD * VIDEO_DAILY_MAX
    },
    referralCode: userLean.referralCode ? String(userLean.referralCode) : userLean.inviteCode ? String(userLean.inviteCode) : "",
    inviteMonthlyCap: INVITE_MONTHLY_CAP,
    invitedRewardCoins: INVITE_REWARD,
    earnMultiplierPreview: earningMultiplierForUser(userLean)
  };
}

/**
 * Admin-only manual coin gift. Credits recipient balance (capped at COIN_CAP) and writes audit log.
 * @param {import("mongoose").Model} User
 * @param {import("mongoose").Model} CoinGiftLog
 * @param {{ recipientUserId: string; adminUserId: string; amount: number; reason?: string }} opts
 */
async function adminGiftCoins(User, CoinGiftLog, opts) {
  const recipientUserId = opts && opts.recipientUserId ? String(opts.recipientUserId) : "";
  const adminUserId = opts && opts.adminUserId ? String(opts.adminUserId) : "";
  const rawAmount = opts && opts.amount;
  const amount = Math.floor(Number(rawAmount));

  if (!recipientUserId) throw new Error("Invalid recipient");
  if (!adminUserId) throw new Error("Invalid admin");
  if (!Number.isFinite(amount) || amount < 1) throw new Error("Amount must be a positive integer");
  if (amount > COIN_CAP) throw new Error(`Amount cannot exceed ${COIN_CAP}`);

  const reason = opts && opts.reason != null ? String(opts.reason).trim().slice(0, 300) : "";

  const recipient = await User.findById(recipientUserId).select("coins username").lean();
  if (!recipient) throw new Error("User not found");

  const balanceBefore = clampCoins(recipient.coins);
  const balanceAfter = clampCoins(balanceBefore + amount);
  const credited = balanceAfter - balanceBefore;

  if (credited < 1) {
    throw new Error("User is already at the coin cap");
  }

  const duplicateWindowMs = 4000;
  const duplicate = await CoinGiftLog.findOne({
    recipientUserId,
    giftedByUserId: adminUserId,
    amount: credited,
    reason,
    createdAt: { $gte: new Date(Date.now() - duplicateWindowMs) }
  })
    .select("_id")
    .lean();

  if (duplicate) {
    throw new Error("Duplicate gift request");
  }

  await User.findByIdAndUpdate(recipientUserId, { $set: { coins: balanceAfter } }, { runValidators: false });

  const log = await CoinGiftLog.create({
    recipientUserId,
    giftedByUserId: adminUserId,
    amount: credited,
    balanceBefore,
    balanceAfter,
    reason,
    source: "admin_gift"
  });

  return {
    credited,
    balanceBefore,
    balanceAfter,
    capped: credited < amount,
    logId: log._id
  };
}

module.exports = {
  utcTodayString,
  clampCoins,
  earningMultiplierForUser,
  scaledReward,
  ensureReferralCode,
  finalizeInviteBonus,
  finalizeInviteBonusById,
  bindReferralCode,
  backfillMissingInviteCodes,
  claimDailyLogin,
  claimVideoReward,
  redeemStandardWithCoins,
  buildCoinsStatusPayload,
  enrichCoinsStatusWithInviteStats,
  trialDaysRemainingMs,
  adminGiftCoins
};
