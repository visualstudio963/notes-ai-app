const chrono = require("chrono-node");

function extractReminderDetails(text) {
  try {
    const results = chrono.parse(text, new Date(), { forwardDate: true });
    if (results.length === 0) {
      return null;
    }

    const result = results[0];
    const date = result.start.date();

    let message = text;
    if (result.text) {
      message = text.replace(result.text, "").trim();
    }

    message = message
      .replace(/^(kujto|remind|mos harro|remember)/i, "")
      .replace(/^(me|to)/i, "")
      .trim();

    if (!message) {
      message = "Personal reminder";
    }

    if (!message.match(/^(mos harro|remember|kujto)/i)) {
      message = `Mos harro: ${message}`;
    }

    return {
      message,
      time: date
    };
  } catch {
    return null;
  }
}

function isValidFutureDate(date) {
  return new Date(date) > new Date();
}

function formatReminderForWhatsApp(reminder) {
  const timeString = reminder.time.toLocaleString("sq-AL", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });

  return `🔔 KUJTESË: ${reminder.message}\n⏰ Koha: ${timeString}`;
}

module.exports = {
  extractReminderDetails,
  isValidFutureDate,
  formatReminderForWhatsApp
};
