#!/usr/bin/env node
/**
 * Stages the CODE layer (small, changes every release):
 *
 *   desktop/build/backend   backend source (tests, docs, dev data and local state excluded)
 *   desktop/build/config    config/ with secret-looking values blanked
 *
 * Run AFTER prepare-env.mjs: the backend is byte-compiled with the environment's
 * own interpreter so the .pyc files match the Python that will run them.
 * The frontend is staged separately by prepare-frontend.mjs.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const IS_WIN = process.platform === "win32";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUILD = path.join(ROOT, "desktop", "build");

function stageBackend() {
  const src = path.join(ROOT, "backend");
  const dest = path.join(BUILD, "backend");
  fs.rmSync(dest, { recursive: true, force: true });

  const skipNames = new Set(["tests", "docs", "__pycache__", ".pytest_cache", ".git", ".venv", "venv", "node_modules"]);
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (p) => {
      const rel = path.relative(src, p);
      const base = path.basename(p);
      if (skipNames.has(base)) return false;
      if (rel === "storage" || rel.startsWith(`storage${path.sep}`)) return false; // local dev state, never ship
      if (/^\.env(\..*)?$/.test(base)) return false;
      if (/\.(log|db|db-wal|db-shm|sqlite3?)$/i.test(base)) return false;
      return true;
    },
  });
}

/** Ship config/ but never the maintainer's credentials. */
function stageConfig() {
  const src = path.join(ROOT, "config");
  const dest = path.join(BUILD, "config");
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });

  const secretKey =
    /^(\s*(?:[A-Za-z0-9_.-]*(?:api_key|apikey|token|secret|password|access_key)[A-Za-z0-9_.-]*)\s*=\s*)(["'])(.+?)\2(.*)$/i;
  const scrubbed = [];
  for (const name of fs.readdirSync(dest)) {
    if (!/\.(toml|json|ya?ml|env)$/i.test(name)) continue;
    const file = path.join(dest, name);
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    const out = lines.map((line, i) => {
      const m = line.match(secretKey);
      if (!m) return line;
      scrubbed.push(`${name}:${i + 1} ${m[1].trim().replace(/\s*=$/, "")}`);
      return `${m[1]}${m[2]}${m[2]}${m[4]}`;
    });
    fs.writeFileSync(file, out.join("\n"));
  }
  if (scrubbed.length) {
    console.log(`Blanked ${scrubbed.length} secret-looking value(s) in the bundled config (names only):`);
    scrubbed.forEach((s) => console.log(`  - ${s}`));
    console.log("Remove them from the repository too, and rotate any real keys.");
  }
}

stageBackend();
stageConfig();

const py = IS_WIN
  ? path.join(BUILD, "env", "python", "python.exe")
  : path.join(BUILD, "env", "python", "bin", "python3");
if (fs.existsSync(py)) {
  const r = spawnSync(py, ["-m", "compileall", "-q", "-j", "0", "--invalidation-mode", "checked-hash", path.join(BUILD, "backend")], {
    stdio: "inherit",
  });
  if (r.status !== 0) console.warn("compileall reported problems in backend (see above)");
} else {
  console.warn("build/env/python not found: skipping byte-compile (run prepare-env.mjs first for faster first start)");
}
console.log("Code staged in", BUILD);
