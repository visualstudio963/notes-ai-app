const twilio = require("twilio");

const client = twilio(
  process.env.TWILIO_SID,
  process.env.TWILIO_AUTH_TOKEN
);

async function sendWhatsAppMessage(to, category, text) {
  try {
    await client.messages.create({
      from: "whatsapp:+14155238886",
      to: `whatsapp:${to}`,
      body: `📝 Nota juaj në "${category}" u ruajt me sukses:\n\n"${text}"`
    });
  } catch (err) {
    console.error("WhatsApp error:", err.message);
  }
}

module.exports = sendWhatsAppMessage;