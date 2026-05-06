/**
 * Replace __BUILD_HASH__ in frontend/public HTML + sw.js before Vercel deploy.
 * Keeps immutable URL tokens locally as __BUILD_HASH__; CI substitutes a short git SHA or timestamp.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "frontend", "public");
const TOKEN = "__BUILD_HASH__";

const raw =
  process.env.VERCEL_GIT_COMMIT_SHA ||
  process.env.VERCEL_DEPLOYMENT_ID ||
  process.env.CF_PAGES_COMMIT_SHA ||
  process.env.GITHUB_SHA ||
  "";
/** Twelve hex chars keeps query strings short; fallback is unique per non-CI run. */
const BUILD = raw ? raw.slice(0, 12) : `local-${Date.now().toString(36)}`;

function patch(relPath) {
  const fp = path.join(publicDir, relPath);
  if (!fs.existsSync(fp)) {
    console.warn(`inject-build-hash: missing ${relPath}`);
    return;
  }
  let body = fs.readFileSync(fp, "utf8");
  if (!body.includes(TOKEN)) {
    console.warn(`inject-build-hash: no ${TOKEN} in ${relPath} (skip)`);
    return;
  }
  body = body.split(TOKEN).join(BUILD);
  fs.writeFileSync(fp, body, "utf8");
  console.log(`inject-build-hash: patched ${relPath} → ${BUILD}`);
}

const htmlFiles = fs.readdirSync(publicDir).filter((f) => f.endsWith(".html"));
for (const f of htmlFiles) patch(f);

patch("sw.js");

console.log(`inject-build-hash: done (BUILD=${BUILD})`);
