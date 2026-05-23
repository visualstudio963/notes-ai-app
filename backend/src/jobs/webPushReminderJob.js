const webpush = require("web-push");

function getPushErrorStatusCode(err) {
  if (!err) return 0;
  if (typeof err.statusCode === "number") return err.statusCode;
  const m = String(err.message || "").match(/\b(40[04]|410)\b/);
  if (m) return parseInt(m[1], 10);
  return 0;
}

/**
 * Sends web push for due web reminders and marks them sent after at least one successful delivery.
 * Uses per-reminder lock (webPushLockUntil) to avoid duplicate sends under overlapping cron ticks.
 *
 * @param {object} opts
 * @param {import('mongoose').Model} opts.Reminder
 * @param {import('mongoose').Model} opts.User
 * @param {string|null} opts.vapidPublicKey
 * @param {string|null} opts.vapidPrivateKey
 * @param {string|null} opts.vapidSubject mailto: or https: URL
 * @param {string} [opts.publicAppUrl]
 */
function createWebPushReminderJob({
  Reminder,
  User,
  vapidPublicKey,
  vapidPrivateKey,
  vapidSubject,
  publicAppUrl = ""
}) {
  const configured = !!(vapidPublicKey && vapidPrivateKey && vapidSubject);
  if (configured) {
    try {
      webpush.setVapidDetails(String(vapidSubject).trim(), String(vapidPublicKey).trim(), String(vapidPrivateKey).trim());
    } catch (e) {
      console.error("[web-push] setVapidDetails failed:", e && e.message);
    }
  }

  let sweepRunning = false;
  const LOCK_MS = 120000;
  const MAX_PER_TICK = 30;

  return async function webPushReminderSweep() {
    if (!configured) return;
    if (sweepRunning) return;
    sweepRunning = true;
    const now = new Date();
    let processed = 0;

    try {
      while (processed < MAX_PER_TICK) {
        const lockUntil = new Date(Date.now() + LOCK_MS);
        const reminder = await Reminder.findOneAndUpdate(
          {
            sent: false,
            status: "pending",
            notificationType: "web",
            time: { $lte: now },
            $or: [{ webPushLockUntil: { $exists: false } }, { webPushLockUntil: { $lt: now } }]
          },
          { $set: { webPushLockUntil: lockUntil } },
          { new: true, sort: { time: 1 } }
        ).lean();

        if (!reminder) break;
        processed += 1;

        const stillThere = await Reminder.findById(reminder._id).select("sent status").lean();
        if (!stillThere || stillThere.sent || stillThere.status !== "pending") {
          await Reminder.updateOne({ _id: reminder._id }, { $unset: { webPushLockUntil: 1 } });
          continue;
        }

        const user = await User.findById(reminder.userId).select("pushSubscriptions").lean();
        const subs = user && Array.isArray(user.pushSubscriptions) ? user.pushSubscriptions : [];

        if (!subs.length) {
          await Reminder.updateOne({ _id: reminder._id }, { $unset: { webPushLockUntil: 1 } });
          continue;
        }

        const base =
          typeof publicAppUrl === "string" && publicAppUrl
            ? String(publicAppUrl).replace(/\/$/, "")
            : "";
        const url = `${base}/#home`;

        const payload = {
          reminderId: String(reminder._id),
          title: "Reminder",
          body: String(reminder.message || "").slice(0, 220),
          url,
          icon: "/icons/icon-192.png",
          badge: "/icons/badge-72.png"
        };
        const payloadStr = JSON.stringify(payload);

        let anySuccess = false;
        for (const sub of subs) {
          if (!sub || !sub.endpoint || !sub.keys) continue;
          const pushSub = {
            endpoint: sub.endpoint,
            keys: {
              p256dh: sub.keys.p256dh,
              auth: sub.keys.auth
            }
          };
          try {
            await webpush.sendNotification(pushSub, payloadStr, {
              TTL: 3600,
              urgency: "high"
            });
            anySuccess = true;
          } catch (err) {
            const code = getPushErrorStatusCode(err);
            if (code === 404 || code === 410) {
              await User.updateOne(
                { _id: reminder.userId },
                { $pull: { pushSubscriptions: { endpoint: sub.endpoint } } }
              );
            }
          }
        }

        if (anySuccess) {
          await Reminder.updateOne(
            { _id: reminder._id, sent: false },
            {
              $set: { sent: true, sentAt: new Date(), status: "sent" },
              $unset: { webPushLockUntil: 1 }
            }
          );
        } else {
          await Reminder.updateOne({ _id: reminder._id }, { $unset: { webPushLockUntil: 1 } });
        }
      }
    } catch (e) {
      console.warn("[web-push] sweep:", e && e.message ? e.message : e);
    } finally {
      sweepRunning = false;
    }
  };
}

module.exports = { createWebPushReminderJob };
