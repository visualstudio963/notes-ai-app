const twilio = require("twilio");

function getClient() {
  const sid = process.env.TWILIO_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) {
    return null;
  }
  return twilio(sid, token);
}

async function sendWhatsAppMessage(to, category, text) {
  const client = getClient();
  const from = process.env.TWILIO_WHATSAPP_NUMBER;
  if (!client || !from) {
    throw new Error("Twilio is not configured");
  }

  const body = `📝 ${category}\n\n${text}`;
  return client.messages.create({
    from,
    to: `whatsapp:${to}`,
    body
  });
}

module.exports = sendWhatsAppMessage;
