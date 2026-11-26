#!/usr/bin/env node
/**
 * Regenerates desktop/locks/<platform>.txt from backend/requirements.txt:
 * exact versions + sha256 hashes for every target platform, resolved from any
 * machine. Requires uv (https://docs.astral.sh/uv/ — `pip install uv`).
 *
 * Run it whenever backend/requirements.txt changes, and commit the result.
 * Changing a lock file changes the environment id, so users download a new
 * runtime on the next update (that is the intended trigger).
 */
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const config = JSON.parse(fs.readFileSync(path.join(ROOT, "desktop", "env-config.json"), "utf8"));

const TARGETS = {
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc",
};

fs.mkdirSync(path.join(ROOT, "desktop", "locks"), { recursive: true });
let failed = 0;
for (const [key, platform] of Object.entries(TARGETS)) {
  const out = path.join("desktop", "locks", `${key}.txt`);
  const r = spawnSync(
    "uv",
    [
      "pip", "compile", path.join("backend", "requirements.txt"),
      "--generate-hashes", "--no-annotate",
      "--python-version", config.pythonMinor,
      "--python-platform", platform,
      "--custom-compile-command", "npm run lock (in desktop/)",
      "-o", out,
    ],
    { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" }
  );
  console.log(`${r.status === 0 ? "OK  " : "FAIL"} ${key}`);
  if (r.status !== 0) failed++;
}
process.exit(failed ? 1 : 0);
