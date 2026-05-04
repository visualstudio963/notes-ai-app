const { hasActivePremium } = require("../features/premium/subscriptionService");

function createReminderChecker({ Reminder, sendWhatsAppMessage, aiMemoryService }) {
  return async function checkReminders() {
    const now = new Date();

    const dueReminders = await Reminder.find({
      sent: false,
      status: "pending",
      notificationType: "whatsapp",
      time: { $lte: now }
    }).populate("userId", "firstName lastName isPremium premiumExpires plan subscriptionPlan membershipRole");

    for (const reminder of dueReminders) {
      try {
        const user = reminder.userId;
        if (!user || !hasActivePremium(user)) {
          reminder.status = "failed";
          await reminder.save();
          continue;
        }

        const phone = reminder.phone;

        if (!phone) {
          reminder.status = "failed";
          await reminder.save();
          continue;
        }

        let whatsappMessage;
        if (reminder.type === "ai_memory") {
          whatsappMessage = aiMemoryService.formatReminderForWhatsApp(reminder);
        } else {
          whatsappMessage = `🔔 KUJTESË: ${reminder.message}`;
          if (reminder.category) {
            whatsappMessage += `\n📁 Kategoria: ${reminder.category}`;
          }
        }

        await sendWhatsAppMessage(phone, "Kujtesë", whatsappMessage);

        reminder.sent = true;
        reminder.sentAt = new Date();
        reminder.status = "sent";
        await reminder.save();
      } catch {
        reminder.status = "failed";
        await reminder.save();
      }
    }
  };
}

module.exports = { createReminderChecker };
