/**
 * Safe MongoDB migration: replace legacy frontend origin in stored strings only.
 *
 * Replaces https://notes-ai-app-theta.vercel.app (and http variant) with PUBLIC_APP_URL.
 * Does NOT modify referralCode, inviteCode, tokens, passwords, or Stripe IDs.
 *
 * Usage:
 *   node scripts/migrate-public-app-domain.mjs --dry-run
 *   node scripts/migrate-public-app-domain.mjs
 *
 * Requires MONGO_URI in project root .env (same as backend).
 */

import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import mongoose from "mongoose";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const OLD_ORIGINS = [
  "https://notes-ai-app-theta.vercel.app",
  "http://notes-ai-app-theta.vercel.app"
];

const NEW_ORIGIN = String(process.env.PUBLIC_APP_URL || "https://notesai.space")
  .trim()
  .replace(/\/+$/, "");

const SKIP_KEYS = new Set([
  "referralCode",
  "inviteCode",
  "password",
  "refreshToken",
  "emailVerificationTokenHash",
  "googleId",
  "stripeSubscriptionId",
  "billingCustomerId",
  "deviceId",
  "_id",
  "__v"
]);

const dryRun = process.argv.includes("--dry-run");

function migrateString(value) {
  if (typeof value !== "string" || !value.includes("notes-ai-app-theta.vercel.app")) {
    return { next: value, changed: false };
  }
  let next = value;
  for (const old of OLD_ORIGINS) {
    if (next.includes(old)) {
      next = next.split(old).join(NEW_ORIGIN);
    }
  }
  return { next, changed: next !== value };
}

function walkValue(value, keyPath) {
  const leafKey = keyPath[keyPath.length - 1] || "";
  if (SKIP_KEYS.has(leafKey)) {
    return { value, changed: false };
  }

  if (typeof value === "string") {
    const { next, changed } = migrateString(value);
    return { value: next, changed };
  }

  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item, i) => {
      const r = walkValue(item, keyPath.concat(String(i)));
      if (r.changed) changed = true;
      return r.value;
    });
    return { value: next, changed };
  }

  if (value && typeof value === "object" && !(value instanceof Date) && !mongoose.isValidObjectId(value)) {
    let changed = false;
    const next = {};
    for (const [k, v] of Object.entries(value)) {
      const r = walkValue(v, keyPath.concat(k));
      if (r.changed) changed = true;
      next[k] = r.value;
    }
    return { value: next, changed };
  }

  return { value, changed: false };
}

async function main() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    console.error("Missing MONGO_URI in .env");
    process.exit(1);
  }

  console.log(`Target origin: ${NEW_ORIGIN}`);
  console.log(`Mode: ${dryRun ? "DRY RUN" : "APPLY"}`);

  await mongoose.connect(mongoUri, { maxPoolSize: 4 });

  const db = mongoose.connection.db;
  const collections = await db.listCollections().toArray();

  let docsScanned = 0;
  let docsUpdated = 0;
  let fieldsUpdated = 0;

  for (const { name } of collections) {
    const col = db.collection(name);
    const cursor = col.find({});
    // eslint-disable-next-line no-await-in-loop
    for await (const doc of cursor) {
      docsScanned += 1;
      const { value: next, changed } = walkValue(doc, []);
      if (!changed) continue;

      fieldsUpdated += 1;
      docsUpdated += 1;

      if (dryRun) {
        console.log(`[dry-run] would update ${name}/${doc._id}`);
        continue;
      }

      const { _id, ...rest } = next;
      // eslint-disable-next-line no-await-in-loop
      await col.replaceOne({ _id }, rest);
      console.log(`updated ${name}/${_id}`);
    }
  }

  await mongoose.disconnect();

  console.log(`Done. scanned=${docsScanned} docs_with_changes=${docsUpdated} field_trees=${fieldsUpdated}`);
  if (dryRun) {
    console.log("Re-run without --dry-run to apply.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
