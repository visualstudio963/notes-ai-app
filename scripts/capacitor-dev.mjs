import { spawn } from "node:child_process";

const args = process.argv.slice(2);
if (!args.length) {
  console.error("Usage: node scripts/capacitor-dev.mjs <cap args...>");
  console.error("Example: node scripts/capacitor-dev.mjs sync");
  process.exit(1);
}

const serverUrl = (process.env.CAP_SERVER_URL || "http://localhost:3000").trim();
if (!/^https?:\/\//i.test(serverUrl)) {
  console.error(`CAP_SERVER_URL must start with http:// or https://. Got: ${serverUrl}`);
  process.exit(1);
}

const child = spawn("npx", ["cap", ...args], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: {
    ...process.env,
    CAP_SERVER_URL: serverUrl
  }
});

child.on("exit", (code) => {
  process.exit(code ?? 1);
});

