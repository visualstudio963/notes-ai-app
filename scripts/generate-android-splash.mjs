/**
 * Generate native Android splash PNGs (gradient + logo + tagline).
 * Usage: node scripts/generate-android-splash.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const logoPath = path.join(root, "assets", "branding", "notes-ai-app-icon-1024.png");
const resDir = path.join(root, "android", "app", "src", "main", "res");

/** Capacitor / Android splash asset sizes (w × h). */
const SPLASH_SIZES = {
  drawable: { w: 480, h: 320 },
  "drawable-port-mdpi": { w: 320, h: 480 },
  "drawable-port-hdpi": { w: 480, h: 800 },
  "drawable-port-xhdpi": { w: 720, h: 1280 },
  "drawable-port-xxhdpi": { w: 960, h: 1600 },
  "drawable-port-xxxhdpi": { w: 1280, h: 1920 },
  "drawable-land-mdpi": { w: 480, h: 320 },
  "drawable-land-hdpi": { w: 800, h: 480 },
  "drawable-land-xhdpi": { w: 1280, h: 720 },
  "drawable-land-xxhdpi": { w: 1600, h: 960 },
  "drawable-land-xxxhdpi": { w: 1920, h: 1280 },
};

function backgroundSvg(w, h) {
  return `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#060B18"/>
      <stop offset="42%" stop-color="#0F172A"/>
      <stop offset="100%" stop-color="#312E81"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="36%" r="52%">
      <stop offset="0%" stop-color="#22D3EE" stop-opacity="0.22"/>
      <stop offset="55%" stop-color="#6366F1" stop-opacity="0.12"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="pulse" cx="50%" cy="36%" r="28%">
      <stop offset="0%" stop-color="#A5F3FC" stop-opacity="0.14"/>
      <stop offset="100%" stop-color="#A5F3FC" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#bg)"/>
  <rect width="100%" height="100%" fill="url(#glow)"/>
  <rect width="100%" height="100%" fill="url(#pulse)"/>
</svg>`;
}

function textSvg(w, h, titleY) {
  const titleSize = Math.max(18, Math.round(h * 0.028));
  const subSize = Math.max(12, Math.round(h * 0.017));
  const subY = titleY + Math.round(titleSize * 1.55);
  return `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
  <text x="50%" y="${titleY}" text-anchor="middle"
    font-family="Inter, Segoe UI, Roboto, Helvetica, Arial, sans-serif"
    font-size="${titleSize}" font-weight="700" fill="#F8FAFC" letter-spacing="0.04em">Notes AI</text>
  <text x="50%" y="${subY}" text-anchor="middle"
    font-family="Inter, Segoe UI, Roboto, Helvetica, Arial, sans-serif"
    font-size="${subSize}" font-weight="500" fill="#94A3B8" letter-spacing="0.08em">Smart Notes &amp; Productivity</text>
</svg>`;
}

async function renderSplash(w, h) {
  const isLandscape = w > h;
  const logoSize = Math.round(Math.min(w, h) * (isLandscape ? 0.36 : 0.3));
  const centerY = Math.round(h * (isLandscape ? 0.46 : 0.36));
  const logoTop = centerY - Math.round(logoSize / 2);
  const logoLeft = Math.round((w - logoSize) / 2);
  const titleY = logoTop + logoSize + Math.round(h * (isLandscape ? 0.06 : 0.045));

  const logo = await sharp(logoPath).resize(logoSize, logoSize, { fit: "cover" }).png().toBuffer();
  const bg = await sharp(Buffer.from(backgroundSvg(w, h))).png().toBuffer();
  const text = await sharp(Buffer.from(textSvg(w, h, titleY))).png().toBuffer();

  return sharp(bg)
    .composite([
      { input: logo, top: logoTop, left: logoLeft },
      { input: text, top: 0, left: 0 },
    ])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function renderSplashLogo(size) {
  return sharp(logoPath)
    .resize(size, size, { fit: "cover" })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function writeFile(filePath, buffer) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, buffer);
}

async function main() {
  if (!fs.existsSync(logoPath)) {
    console.error(`Logo not found: ${logoPath}`);
    process.exit(1);
  }

  for (const [folder, { w, h }] of Object.entries(SPLASH_SIZES)) {
    const png = await renderSplash(w, h);
    await writeFile(path.join(resDir, folder, "splash.png"), png);
    console.log(`wrote ${folder}/splash.png (${w}x${h})`);
  }

  const logoSizes = {
    "drawable-mdpi": 108,
    "drawable-hdpi": 162,
    "drawable-xhdpi": 216,
    "drawable-xxhdpi": 324,
    "drawable-xxxhdpi": 432,
  };

  for (const [folder, size] of Object.entries(logoSizes)) {
    const icon = await renderSplashLogo(size);
    const pulse = await sharp(icon).modulate({ brightness: 1.08, saturation: 1.05 }).png().toBuffer();
    await writeFile(path.join(resDir, folder, "splash_icon.png"), icon);
    await writeFile(path.join(resDir, folder, "splash_icon_pulse.png"), pulse);
    console.log(`wrote ${folder}/splash_icon*.png (${size}px)`);
  }

  console.log("Android splash assets generated.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
