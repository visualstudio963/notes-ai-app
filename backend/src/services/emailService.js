const nodemailer = require("nodemailer");

const SMTP_HOST = String(process.env.SMTP_HOST || "").trim();
const SMTP_PORT = Number.parseInt(process.env.SMTP_PORT || "587", 10);
const SMTP_USER = String(process.env.SMTP_USER || "").trim();
const SMTP_PASS = String(process.env.SMTP_PASS || "").trim();
const SMTP_FROM = String(process.env.SMTP_FROM || SMTP_USER || "no-reply@notes-ai.local").trim();

let cachedTransporter = null;

function getTransporter() {
  if (cachedTransporter) return cachedTransporter;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    return null;
  }
  cachedTransporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number.isFinite(SMTP_PORT) ? SMTP_PORT : 587,
    secure: SMTP_PORT === 465,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS
    }
  });
  return cachedTransporter;
}

async function sendVerificationEmail({ to, firstName, verifyUrl }) {
  const transporter = getTransporter();
  if (!transporter) {
    console.warn(`[email] SMTP not configured. Verification link for ${to}: ${verifyUrl}`);
    return;
  }

  const safeName = String(firstName || "").trim() || "there";
  await transporter.sendMail({
    from: SMTP_FROM,
    to,
    subject: "Verify your email",
    text: `Hi ${safeName},\n\nPlease verify your email by opening this link:\n${verifyUrl}\n\nIf this was not you, you can ignore this message.`,
    html: `<p>Hi ${safeName},</p><p>Please verify your email by clicking this link:</p><p><a href="${verifyUrl}">${verifyUrl}</a></p><p>If this was not you, you can ignore this message.</p>`
  });
}

module.exports = { sendVerificationEmail };
