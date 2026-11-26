#!/usr/bin/env node
/**
 * Builds the Next.js frontend as a standalone server and stages it in
 * desktop/build/frontend (server.js + minimal node_modules + static + public).
 *
 * The backend URL is baked into the build (next.config.mjs rewrites are
 * evaluated at build time), so it must match src/ports.json.
 *
 * Note: layout.tsx uses next/font/google, which downloads fonts during
 * `next build` — the machine running this needs internet access.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const IS_WIN = process.platform === "win32";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FRONT = path.join(ROOT, "frontend");
const DEST = path.join(ROOT, "desktop", "build", "frontend");
const ports = JSON.parse(fs.readFileSync(path.join(ROOT, "desktop", "src", "ports.json"), "utf8"));

function run(args, env = {}) {
  // npm is npm.cmd on Windows, which needs a shell to be spawned.
  const r = spawnSync("npm", args, {
    cwd: FRONT,
    stdio: "inherit",
    shell: IS_WIN,
    env: { ...process.env, ...env },
  });
  if (r.status !== 0) throw new Error(`npm ${args.join(" ")} failed (${r.status})`);
}

if (!fs.existsSync(path.join(FRONT, "node_modules"))) run(["ci", "--no-audit", "--no-fund"]);

run(["run", "build"], {
  PELDRUN_STANDALONE: "1",
  PELDRUN_BACKEND_URL: `http://127.0.0.1:${ports.backend}`,
  NEXT_TELEMETRY_DISABLED: "1",
});

const standalone = path.join(FRONT, ".next", "standalone");
if (!fs.existsSync(path.join(standalone, "server.js"))) {
  throw new Error("`.next/standalone/server.js` not found — is output: 'standalone' enabled (PELDRUN_STANDALONE=1)?");
}

fs.rmSync(DEST, { recursive: true, force: true });
fs.mkdirSync(path.dirname(DEST), { recursive: true });
fs.cpSync(standalone, DEST, { recursive: true });
fs.cpSync(path.join(FRONT, ".next", "static"), path.join(DEST, ".next", "static"), { recursive: true });
if (fs.existsSync(path.join(FRONT, "public"))) {
  fs.cpSync(path.join(FRONT, "public"), path.join(DEST, "public"), { recursive: true });
}
console.log("Frontend staged in", DEST);
