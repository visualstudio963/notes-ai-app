const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Removes old "past" reminders so the DB does not grow unbounded with history.
 * Only affects reminders whose job window has ended — never future pending ones.
 *
 * - Sent: purge when sentAt is older than retention (fallback: scheduled time).
 * - Never sent but past due (web / stuck pending): purge when scheduled time is older than retention.
 * - Failed delivery: purge when scheduled time is older than retention.
 */
function createPurgePastReminders({ Reminder, retentionDays = 7 }) {
  return async function purgePastReminders() {
    const cutoff = new Date(Date.now() - retentionDays * MS_PER_DAY);

    const result = await Reminder.deleteMany({
      $or: [
        { sent: true, sentAt: { $lte: cutoff } },
        {
          sent: true,
          $or: [{ sentAt: { $exists: false } }, { sentAt: null }],
          time: { $lte: cutoff }
        },
        { sent: false, status: "pending", time: { $lte: cutoff } },
        { status: "failed", time: { $lte: cutoff } }
      ]
    });

    if (result.deletedCount > 0) {
      console.info(
        `[reminders] purged ${result.deletedCount} past reminder(s) older than ${retentionDays}d (cutoff ${cutoff.toISOString()})`
      );
    }

    return result;
  };
}

module.exports = { createPurgePastReminders };
