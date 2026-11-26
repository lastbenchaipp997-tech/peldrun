#!/usr/bin/env node
/**
 * Launches the PACKAGED app (unpacked folder or macOS .app) in --smoke-test mode
 * and fails unless it reports OK. Used by CI after electron-builder.
 *
 *   node scripts/smoke.mjs [dist|dist-full]
 *
 * Env:
 *   PELDRUN_ENV_ARCHIVE         local env archive (lite flavor: avoids the network download)
 *   PELDRUN_SMOKE_NO_SANDBOX=1  add --no-sandbox --disable-gpu (root containers / some CI images)
 *   PELDRUN_SMOKE_SCREENSHOT=1  also render the UI and save a PNG next to the result file
 *
 * Linux needs a display: run as `xvfb-run -a node scripts/smoke.mjs`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, process.argv[2] || "dist");

function findExecutable() {
  if (process.platform === "linux") return path.join(dist, "linux-unpacked", "peldrun");
  if (process.platform === "win32") return path.join(dist, "win-unpacked", "PELDRUN.exe");
  for (const d of fs.readdirSync(dist)) {
    const app = path.join(dist, d, "PELDRUN.app", "Contents", "MacOS", "PELDRUN");
    if (fs.existsSync(app)) return app;
  }
  throw new Error(`Packaged macOS app not found in ${dist}`);
}

const exe = findExecutable();
if (!fs.existsSync(exe)) throw new Error(`Packaged executable not found: ${exe}`);

const result = path.join(os.tmpdir(), `peldrun-smoke-${process.pid}.txt`);
const args = [`--smoke-test=${result}`];
if (process.env.PELDRUN_SMOKE_SCREENSHOT === "1") args.push(`--smoke-screenshot=${result.replace(/\.txt$/, ".png")}`);
if (process.env.PELDRUN_SMOKE_NO_SANDBOX === "1") args.push("--no-sandbox", "--disable-gpu");

const r = spawnSync(exe, args, { stdio: "inherit", timeout: 600_000 });
const out = fs.existsSync(result) ? fs.readFileSync(result, "utf8").trim() : "(no result file written)";
console.log(`smoke test: ${out} (exit ${r.status})`);
if (process.env.PELDRUN_SMOKE_SCREENSHOT === "1") console.log(`screenshot: ${result.replace(/\.txt$/, ".png")}`);
process.exit(out === "OK" ? 0 : 1);
