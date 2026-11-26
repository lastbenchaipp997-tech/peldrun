#!/usr/bin/env node
/**
 * Builds the ENVIRONMENT layer for the OS/arch this script runs on:
 * a standalone CPython + every backend dependency (pinned, hash-checked) +
 * Playwright's Chromium. Platform-specific, so run it once per target
 * (see .github/workflows/desktop-release.yml).
 *
 * Output
 *   desktop/build/env/python           interpreter + site-packages
 *   desktop/build/env/browsers         Playwright Chromium (unless skipped)
 *   desktop/build/env-archive/*.tar.gz the same tree as one archive (the "lite" installer downloads this)
 *   desktop/build/env.json             {id, sha256, size, url, ...} read by the app at runtime
 *
 * The env id is a hash of everything that shapes the environment (lock file,
 * Python build, revision, flags). Same id = same bytes = no re-download on update.
 *
 * Env vars
 *   PELDRUN_ENV_URL_TEMPLATE  where the archive will be hosted, e.g.
 *                          https://github.com/OWNER/REPO/releases/download/env-{id}/{file}
 *   PELDRUN_SKIP_BROWSERS  1 = do not install Chromium (local testing only)
 *   PELDRUN_NO_TRIM        1 = keep test suites inside site-packages
 *   PELDRUN_NO_ARCHIVE     1 = skip the .tar.gz (dev-only)
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const IS_WIN = process.platform === "win32";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DESKTOP = path.join(ROOT, "desktop");
const BUILD = path.join(DESKTOP, "build");
const ENV_DIR = path.join(BUILD, "env");
const ARCHIVE_DIR = path.join(BUILD, "env-archive");
const CACHE = path.join(DESKTOP, ".cache");
const config = JSON.parse(fs.readFileSync(path.join(DESKTOP, "env-config.json"), "utf8"));

const TRIPLES = {
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc",
};
const KEY = `${process.platform}-${process.arch}`;
const TRIPLE = TRIPLES[KEY];
if (!TRIPLE) throw new Error(`Unsupported build platform: ${KEY}`);

/** Windows: use the system bsdtar; Git-for-Windows' GNU tar misreads "C:\\..." as a remote host. */
const TAR = IS_WIN ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.status !== 0) throw new Error(`Command failed (${r.status}): ${cmd} ${args.join(" ")}`);
}
const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

async function fetchBuffer(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Download failed ${res.status}: ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

// ---------------------------------------------------------------------------

async function stagePython() {
  const prefix = `https://github.com/astral-sh/python-build-standalone/releases/download/${config.pbsTag}`;
  const sums = (await fetchBuffer(`${prefix}/SHA256SUMS`)).toString("utf8");
  const minor = config.pythonMinor.replace(".", "\\.");
  const re = new RegExp(
    `^([0-9a-f]{64})\\s+(cpython-${minor}\\.\\d+\\+${config.pbsTag}-${TRIPLE}-install_only_stripped\\.tar\\.gz)$`,
    "m"
  );
  const m = sums.match(re);
  if (!m) throw new Error(`No CPython ${config.pythonMinor} asset for ${TRIPLE} in release ${config.pbsTag}`);
  const [, expected, asset] = m;

  fs.mkdirSync(CACHE, { recursive: true });
  const archive = path.join(CACHE, asset);
  if (!fs.existsSync(archive) || sha256(archive) !== expected) {
    console.log(`Downloading ${asset}`);
    fs.writeFileSync(archive, await fetchBuffer(`${prefix}/${encodeURIComponent(asset)}`));
  }
  if (sha256(archive) !== expected) throw new Error(`Checksum mismatch for ${asset}`);

  fs.rmSync(ENV_DIR, { recursive: true, force: true });
  fs.mkdirSync(ENV_DIR, { recursive: true });
  run(TAR, ["-xzf", archive, "-C", ENV_DIR]); // archive root folder is "python"

  const py = IS_WIN ? path.join(ENV_DIR, "python", "python.exe") : path.join(ENV_DIR, "python", "bin", "python3");
  if (!fs.existsSync(py)) throw new Error(`Interpreter not found after extract: ${py}`);
  return { py, asset };
}

function installLock(py) {
  const lock = path.join(DESKTOP, "locks", `${KEY}.txt`);
  if (!fs.existsSync(lock)) throw new Error(`Missing lock file ${lock} — run "npm run lock" (needs uv)`);
  // Exact versions + hashes: pip refuses anything that is not in the lock.
  run(py, [
    "-m", "pip", "install",
    "--disable-pip-version-check", "--no-warn-script-location",
    "--require-hashes", "--no-deps",
    "-r", lock,
  ]);
  return lock;
}

function installBrowsers(py) {
  if (!config.includeBrowsers || process.env.PELDRUN_SKIP_BROWSERS === "1") return false;
  const dir = path.join(ENV_DIR, "browsers");
  run(py, ["-m", "playwright", "install", "chromium"], {
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: dir },
  });
  return fs.existsSync(dir);
}

/** Drop bundled test suites; large (pandas, matplotlib, numpy ...) and never imported at runtime. */
function trimSitePackages(py) {
  if (process.env.PELDRUN_NO_TRIM === "1") return;
  const purelib = spawnSync(py, ["-c", "import sysconfig; print(sysconfig.get_paths()['purelib'])"], {
    encoding: "utf8",
  }).stdout.trim();
  let removed = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const p = path.join(dir, e.name);
      if (e.name === "tests" || e.name === "test") {
        fs.rmSync(p, { recursive: true, force: true });
        removed++;
      } else if (e.name !== "__pycache__") {
        walk(p);
      }
    }
  };
  walk(purelib);
  console.log(`Trimmed ${removed} test directories from site-packages`);
}

function precompile(py) {
  // checked-hash pycs stay valid when installers or file copies change mtimes.
  const stdlib = spawnSync(py, ["-c", "import sysconfig; print(sysconfig.get_paths()['stdlib'])"], {
    encoding: "utf8",
  }).stdout.trim();
  const r = spawnSync(py, ["-m", "compileall", "-q", "-j", "0", "--invalidation-mode", "checked-hash", stdlib], {
    stdio: "inherit",
  });
  if (r.status !== 0) console.warn("compileall reported files that do not compile (legacy Python 2 files in packages; harmless)");
}

/**
 * macOS: Apple Silicon refuses unsigned arm64 Mach-O files. Wheels and the
 * standalone interpreter normally carry ad-hoc signatures already; re-signing
 * ad hoc makes that certain. Best effort, UNTESTED here (needs a Mac).
 */
function adHocSignMacBinaries() {
  if (process.platform !== "darwin") return;
  const MAGIC = new Set(["feedface", "feedfacf", "cafebabe", "cffaedfe", "cefaedfe", "bebafeca"]);
  let signed = 0, failed = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.isFile() || fs.statSync(p).size < 4) continue;
      const fd = fs.openSync(p, "r");
      const buf = Buffer.alloc(4);
      fs.readSync(fd, buf, 0, 4, 0);
      fs.closeSync(fd);
      if (!MAGIC.has(buf.toString("hex"))) continue;
      const r = spawnSync("codesign", ["--force", "--sign", "-", p], { stdio: "ignore" });
      r.status === 0 ? signed++ : failed++;
    }
  };
  walk(ENV_DIR);
  console.log(`Ad-hoc signed ${signed} Mach-O files (${failed} failed)`);
}

// ---------------------------------------------------------------------------

const { py, asset } = await stagePython();
const lockFile = installLock(py);
const hasBrowsers = installBrowsers(py);
trimSitePackages(py);
precompile(py);
adHocSignMacBinaries();

const id = createHash("sha256")
  .update(
    JSON.stringify({
      key: KEY,
      lock: sha256(lockFile),
      python: asset,
      revision: config.envRevision,
      trimmed: process.env.PELDRUN_NO_TRIM !== "1",
      browsers: hasBrowsers,
    })
  )
  .digest("hex")
  .slice(0, 16);

const info = {
  id,
  platform: KEY,
  python: IS_WIN ? "python/python.exe" : "python/bin/python3",
  hasBrowsers,
  file: `peldrun-env-${id}-${KEY}.tar.gz`,
  sha256: null,
  size: null,
  url: null,
};

if (process.env.PELDRUN_NO_ARCHIVE !== "1") {
  fs.rmSync(ARCHIVE_DIR, { recursive: true, force: true });
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  const out = path.join(ARCHIVE_DIR, info.file);
  run(TAR, ["-czf", out, "-C", ENV_DIR, ...fs.readdirSync(ENV_DIR)]);
  info.sha256 = sha256(out);
  info.size = fs.statSync(out).size;
  fs.writeFileSync(`${out}.sha256`, `${info.sha256}  ${info.file}\n`);
  // The URL contains the env id, which is only known now, hence a template.
  const template = process.env.PELDRUN_ENV_URL_TEMPLATE || "";
  info.url = template ? template.replace("{id}", id).replace("{file}", info.file) : null;
}

fs.writeFileSync(path.join(BUILD, "env.json"), JSON.stringify(info, null, 2));
console.log(`Environment ${id} staged for ${KEY}${info.size ? ` (${(info.size / 1048576).toFixed(0)} MB archive)` : ""}`);
