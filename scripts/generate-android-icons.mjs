/**
 * Generate Android launcher PNGs from a 1024x1024 master icon.
 * Usage: node scripts/generate-android-icons.mjs [path-to-master.png]
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const defaultMaster = path.join(root, "assets", "branding", "notes-ai-app-icon-1024.png");
const masterPath = path.resolve(process.argv[2] || defaultMaster);
const resDir = path.join(root, "android", "app", "src", "main", "res");

const LAUNCHER_SIZES = {
  "mipmap-mdpi": 48,
  "mipmap-hdpi": 72,
  "mipmap-xhdpi": 96,
  "mipmap-xxhdpi": 144,
  "mipmap-xxxhdpi": 192,
};

const FOREGROUND_SIZES = {
  "mipmap-mdpi": 108,
  "mipmap-hdpi": 162,
  "mipmap-xhdpi": 216,
  "mipmap-xxhdpi": 324,
  "mipmap-xxxhdpi": 432,
};

async function writePng(buffer, outPath) {
  await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
  await fs.promises.writeFile(outPath, buffer);
}

async function resizeIcon(size) {
  return sharp(masterPath)
    .resize(size, size, { fit: "cover", position: "centre" })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
}

async function main() {
  if (!fs.existsSync(masterPath)) {
    console.error(`Master icon not found: ${masterPath}`);
    process.exit(1);
  }

  for (const [folder, size] of Object.entries(LAUNCHER_SIZES)) {
    const png = await resizeIcon(size);
    const base = path.join(resDir, folder);
    await writePng(png, path.join(base, "ic_launcher.png"));
    await writePng(png, path.join(base, "ic_launcher_round.png"));
    console.log(`wrote ${folder} launcher ${size}px`);
  }

  for (const [folder, size] of Object.entries(FOREGROUND_SIZES)) {
    const png = await resizeIcon(size);
    await writePng(png, path.join(resDir, folder, "ic_launcher_foreground.png"));
    console.log(`wrote ${folder} foreground ${size}px`);
  }

  console.log("Android icon PNG generation complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
