/**
 * Replace __BUILD_HASH__ in frontend/public HTML before deploy (query params on assets + inline build id).
 * Service worker stays a static file — only its registration URL picks up a fresh ?v= per deploy.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "frontend", "public");
const TOKEN = "__BUILD_HASH__";
const API_TOKEN = "__API_BASE_URL__";

const raw =
  process.env.VERCEL_GIT_COMMIT_SHA ||
  process.env.VERCEL_DEPLOYMENT_ID ||
  process.env.CF_PAGES_COMMIT_SHA ||
  process.env.GITHUB_SHA ||
  "";
/** Short id for query strings; fallback is unique per non-CI run. */
const BUILD = raw ? raw.slice(0, 12) : `local-${Date.now().toString(36)}`;

/** Production API origin for static builds (Capacitor APK must never use the WebView origin for API). */
const API_BASE =
  (process.env.VITE_API_URL && String(process.env.VITE_API_URL).trim()) ||
  "https://notes-ai-app.onrender.com";

function patch(relPath) {
  const fp = path.join(publicDir, relPath);
  if (!fs.existsSync(fp)) {
    console.warn(`inject-build-hash: missing ${relPath}`);
    return;
  }
  let body = fs.readFileSync(fp, "utf8");
  let changed = false;
  if (body.includes(TOKEN)) {
    body = body.split(TOKEN).join(BUILD);
    changed = true;
  }
  if (body.includes(API_TOKEN)) {
    body = body.split(API_TOKEN).join(API_BASE);
    changed = true;
  }
  if (!changed) {
    console.warn(`inject-build-hash: no ${TOKEN} or ${API_TOKEN} in ${relPath} (skip)`);
    return;
  }
  fs.writeFileSync(fp, body, "utf8");
  console.log(`inject-build-hash: patched ${relPath} (BUILD=${BUILD}, API_BASE=${API_BASE})`);
}

const htmlFiles = fs.readdirSync(publicDir).filter((f) => f.endsWith(".html"));
for (const f of htmlFiles) patch(f);

console.log(`inject-build-hash: done (BUILD=${BUILD})`);
