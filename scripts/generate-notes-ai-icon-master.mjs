/**
 * Generate clean, bright Notes AI launcher master icon (1024×1024).
 * Usage: node scripts/generate-notes-ai-icon-master.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const outPath = path.join(root, "assets", "branding", "notes-ai-app-icon-1024.png");

function iconSvg(size) {
  const s = size;
  const pad = Math.round(s * 0.14);
  const cardW = Math.round(s * 0.46);
  const cardH = Math.round(s * 0.52);
  const cardX = Math.round((s - cardW) / 2);
  const cardY = Math.round(s * 0.22);
  const cardR = Math.round(s * 0.07);
  const lineW = Math.round(cardW * 0.52);
  const lineH = Math.round(s * 0.028);
  const lineR = Math.round(lineH / 2);
  const lineX = cardX + Math.round(cardW * 0.2);
  const line1Y = cardY + Math.round(cardH * 0.32);
  const line2Y = line1Y + Math.round(cardH * 0.16);
  const line3Y = line2Y + Math.round(cardH * 0.16);
  const sparkCx = cardX + cardW + Math.round(s * 0.04);
  const sparkCy = cardY - Math.round(s * 0.03);
  const sparkR = Math.round(s * 0.065);

  return `<svg width="${s}" height="${s}" viewBox="0 0 ${s} ${s}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#06B6D4"/>
      <stop offset="48%" stop-color="#6366F1"/>
      <stop offset="100%" stop-color="#F43F5E"/>
    </linearGradient>
    <linearGradient id="card" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#FFFFFF"/>
      <stop offset="100%" stop-color="#F0F9FF"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="42%" r="42%">
      <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/>
    </radialGradient>
    <filter id="cardShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="${Math.round(s * 0.02)}" stdDeviation="${Math.round(s * 0.025)}" flood-color="#0F172A" flood-opacity="0.28"/>
    </filter>
  </defs>
  <rect width="${s}" height="${s}" rx="${Math.round(s * 0.22)}" fill="url(#bg)"/>
  <rect width="${s}" height="${s}" rx="${Math.round(s * 0.22)}" fill="url(#glow)"/>
  <g filter="url(#cardShadow)">
    <rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="${cardR}" fill="url(#card)"/>
  </g>
  <rect x="${lineX}" y="${line1Y}" width="${lineW}" height="${lineH}" rx="${lineR}" fill="#6366F1" opacity="0.92"/>
  <rect x="${lineX}" y="${line2Y}" width="${Math.round(lineW * 0.78)}" height="${lineH}" rx="${lineR}" fill="#06B6D4" opacity="0.88"/>
  <rect x="${lineX}" y="${line3Y}" width="${Math.round(lineW * 0.58)}" height="${lineH}" rx="${lineR}" fill="#94A3B8" opacity="0.75"/>
  <g transform="translate(${sparkCx}, ${sparkCy})">
    <circle r="${Math.round(sparkR * 1.15)}" fill="#FDE047" opacity="0.35"/>
    <path fill="#FDE047" d="M0 ${-sparkR} L${Math.round(sparkR * 0.28)} ${Math.round(-sparkR * 0.28)} L${sparkR} 0 L${Math.round(sparkR * 0.28)} ${Math.round(sparkR * 0.28)} L0 ${sparkR} L${Math.round(-sparkR * 0.28)} ${Math.round(sparkR * 0.28)} L${-sparkR} 0 L${Math.round(-sparkR * 0.28)} ${Math.round(-sparkR * 0.28)} Z"/>
    <circle r="${Math.round(sparkR * 0.22)}" fill="#FFFFFF" opacity="0.9"/>
  </g>
</svg>`;
}

async function main() {
  const size = 1024;
  const svg = Buffer.from(iconSvg(size));
  const png = await sharp(svg).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
  await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
  await fs.promises.writeFile(outPath, png);
  console.log(`Wrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
