/** Product caps and rewards for coins + trial */

const TRIAL_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

const COIN_CAP = 1200;

const STANDARD_COIN_COST = 600;

/** 30 calendar days extension */
const STANDARD_COIN_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

const DAILY_STREAK_REWARDS = [10, 15, 20, 25, 30, 40, 60];

const VIDEO_REWARD = 10;

const VIDEO_DAILY_MAX = 10;

const INVITE_REWARD = 100;

const INVITE_MONTHLY_CAP = 10;

/** Standard / paid-standard earn slightly less per spec */
const STANDARD_TIER_EARN_MULTIPLIER = 0.85;

module.exports = {
  TRIAL_DURATION_MS,
  COIN_CAP,
  STANDARD_COIN_COST,
  STANDARD_COIN_DURATION_MS,
  DAILY_STREAK_REWARDS,
  VIDEO_REWARD,
  VIDEO_DAILY_MAX,
  INVITE_REWARD,
  INVITE_MONTHLY_CAP,
  STANDARD_TIER_EARN_MULTIPLIER
};
