const crypto = require("crypto");
const {
  COIN_CAP,
  STANDARD_COIN_COST,
  STANDARD_COIN_DURATION_MS,
  DAILY_STREAK_REWARDS,
  VIDEO_REWARD,
  VIDEO_DAILY_MAX,
  INVITE_REWARD,
  INVITE_MONTHLY_CAP,
  STANDARD_TIER_EARN_MULTIPLIER
} = require("./coinConstants");
const { getUserLifecycle, getUserPlan } = require("../premium/subscriptionService");

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

/**
 * Ensures referralCode exists (lazy backfill).
 * @param {import("mongoose").Model} User
 */
async function ensureReferralCode(User, userDoc) {
  const existing = userDoc && userDoc.referralCode ? String(userDoc.referralCode).trim() : "";
  if (existing) return userDoc;
  for (let i = 0; i < 8; i += 1) {
    const code = randomReferralCode();
    try {
      return await User.findByIdAndUpdate(
        userDoc._id,
        { $set: { referralCode: code } },
        { new: true, runValidators: true }
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
  if (inviteeDoc.inviteBonusCreditedAt) return null;

  const inviterOid = inviteeDoc.referredByUserId;
  if (String(inviterOid) === String(inviteeDoc._id)) {
    inviteeDoc.inviteBonusCreditedAt = new Date();
    await inviteeDoc.save();
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

  const reward = scaledReward(INVITE_REWARD, inviter.toObject());
  inviter.inviteFriendMonthYm = ym;
  inviter.inviteFriendMonthCount = monthCount + 1;
  inviter.coins = clampCoins((Number(inviter.coins) || 0) + reward);
  await inviter.save();

  inviteeDoc.inviteBonusCreditedAt = new Date();
  await inviteeDoc.save();

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

  if (invitee.referredByUserId) {
    await finalizeInviteBonus(User, invitee);
    return User.findById(invitee._id).lean();
  }

  const inviter = await User.findOne({ referralCode: normalized }).select("_id referralCode coins");
  if (!inviter || String(inviter._id) === String(invitee._id)) {
    const err = new Error("Invalid invite code.");
    err.statusCode = 400;
    throw err;
  }

  invitee.referredByUserId = inviter._id;
  await invitee.save();

  await finalizeInviteBonus(User, invitee);
  return User.findById(invitee._id).lean();
}

async function claimDailyLogin(User, userId) {
  const user = await User.findById(userId);
  if (!user) {
    const err = new Error("User not found");
    err.statusCode = 404;
    throw err;
  }

  const today = utcTodayString();
  const last = user.dailyLoginUtcDate ? String(user.dailyLoginUtcDate) : "";

  if (last === today) {
    const err = new Error("Daily reward already claimed today.");
    err.statusCode = 409;
    err.code = "DAILY_CLAIMED";
    throw err;
  }

  let nextIdx = Number(user.loginStreakNextIndex) || 1;
  if (nextIdx < 1 || nextIdx > 7) nextIdx = 1;

  if (last && last !== utcYesterdayString()) {
    nextIdx = 1;
  }

  const base = DAILY_STREAK_REWARDS[nextIdx - 1] ?? DAILY_STREAK_REWARDS[0];
  const gained = scaledReward(base, user.toObject());
  user.loginStreakNextIndex = nextIdx >= 7 ? 1 : nextIdx + 1;
  user.dailyLoginUtcDate = today;
  user.coins = clampCoins((Number(user.coins) || 0) + gained);
  await user.save();

  return User.findById(userId).lean();
}

async function claimVideoReward(User, userId) {
  const user = await User.findById(userId);
  if (!user) {
    const err = new Error("User not found");
    err.statusCode = 404;
    throw err;
  }

  const today = utcTodayString();
  let count = Number(user.videoRewardUtcDate === today ? user.videoRewardCount : 0) || 0;
  if (user.videoRewardUtcDate !== today) {
    count = 0;
    user.videoRewardUtcDate = today;
  }
  if (count >= VIDEO_DAILY_MAX) {
    const err = new Error("Daily video reward limit reached.");
    err.statusCode = 429;
    err.code = "VIDEO_CAP";
    throw err;
  }

  const gained = scaledReward(VIDEO_REWARD, user.toObject());
  user.videoRewardCount = count + 1;
  user.videoRewardUtcDate = today;
  user.coins = clampCoins((Number(user.coins) || 0) + gained);
  await user.save();

  return User.findById(userId).lean();
}

async function redeemStandardWithCoins(User, userId) {
  const user = await User.findById(userId);
  if (!user) {
    const err = new Error("User not found");
    err.statusCode = 404;
    throw err;
  }

  const coins = Number(user.coins) || 0;
  if (coins < STANDARD_COIN_COST) {
    const err = new Error(`Need ${STANDARD_COIN_COST} coins to unlock Standard for 30 days.`);
    err.statusCode = 400;
    err.code = "INSUFFICIENT_COINS";
    throw err;
  }

  const now = Date.now();
  let base = now;
  const existingCoin = user.standardCoinExpiresAt ? new Date(user.standardCoinExpiresAt).getTime() : 0;
  if (Number.isFinite(existingCoin) && existingCoin > base) base = existingCoin;

  /** Add 30 days from max(now, coin expiry); Stripe-paid standard still keeps features via plan — coin window stacks for downgrade buffer */
  user.standardCoinExpiresAt = new Date(base + STANDARD_COIN_DURATION_MS);
  user.coins = clampCoins(coins - STANDARD_COIN_COST);
  await user.save();

  return User.findById(userId).lean();
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
  const perInvite = scaledReward(INVITE_REWARD, userLean);
  return {
    ...basePayload,
    inviteFriendsTotal,
    inviteCoinsEarnedThisMonth: monthCount * perInvite
  };
}

function buildCoinsStatusPayload(userLean) {
  const today = utcTodayString();
  const videoCountToday =
    String(userLean.videoRewardUtcDate || "") === today ? Number(userLean.videoRewardCount || 0) || 0 : 0;
  const lifecycle = getUserLifecycle(userLean);
  const trialDaysLeft = lifecycle === "trial" ? trialDaysRemainingMs(userLean) : null;

  const dailyClaimedToday = String(userLean.dailyLoginUtcDate || "") === today;

  const nextStreakRewardIndex = Number(userLean.loginStreakNextIndex) || 1;
  let nextDailyBase = DAILY_STREAK_REWARDS[Math.min(7, Math.max(1, nextStreakRewardIndex)) - 1];
  nextDailyBase = scaledReward(nextDailyBase, userLean);

  return {
    balance: clampCoins(Number(userLean.coins) || 0),
    cap: COIN_CAP,
    standardCoinCost: STANDARD_COIN_COST,
    lifecycle,
    tier: getUserPlan(userLean),
    trialEndsAt: userLean.trialEndsAt ? new Date(userLean.trialEndsAt).toISOString() : null,
    trialDaysTotal: 7,
    trialDaysRemaining: trialDaysLeft,
    standardCoinExpiresAt: userLean.standardCoinExpiresAt
      ? new Date(userLean.standardCoinExpiresAt).toISOString()
      : null,
    dailyLogin: {
      claimedToday: dailyClaimedToday,
      nextStreakIndex: Math.min(7, Math.max(1, nextStreakRewardIndex)),
      nextRewardCoins: nextDailyBase
    },
    videoRewards: {
      countToday: videoCountToday,
      maxToday: VIDEO_DAILY_MAX,
      rewardEach: scaledReward(VIDEO_REWARD, userLean)
    },
    referralCode: userLean.referralCode ? String(userLean.referralCode) : "",
    inviteMonthlyCap: INVITE_MONTHLY_CAP,
    invitedRewardCoins: INVITE_REWARD,
    earnMultiplierPreview: earningMultiplierForUser(userLean)
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
  claimDailyLogin,
  claimVideoReward,
  redeemStandardWithCoins,
  buildCoinsStatusPayload,
  enrichCoinsStatusWithInviteStats,
  trialDaysRemainingMs
};
