"use strict";

/**
 * Resolves the Python environment layer.
 *
 *  - FULL flavor / dev: the interpreter ships inside the app (<res>/python or <res>/env/python).
 *  - LITE flavor: <res>/env.json names a prebuilt archive (id, sha256, url). It is
 *    downloaded once into <userData>/runtimes/<id>, verified against the sha256
 *    that is baked into the (signed) installer, and reused by every later app
 *    version that carries the same id.
 *
 * Test/offline override: PELDRUN_ENV_ARCHIVE=/path/to/peldrun-env-*.tar.gz
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { Readable } = require("node:stream");

const IS_WIN = process.platform === "win32";

/** Electron's net.fetch uses Chromium's network stack: system proxy, PAC files, corporate certificates. */
function httpFetch(url, options) {
  try {
    const { net } = require("electron");
    if (net && typeof net.fetch === "function") return net.fetch(url, options);
  } catch {
    /* not running inside Electron */
  }
  return fetch(url, options);
}

/** Windows: system bsdtar; Git-for-Windows' GNU tar misreads "C:\\..." as a remote host. */
const TAR = IS_WIN ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";

const pythonRel = IS_WIN ? path.join("python", "python.exe") : path.join("python", "bin", "python3");

function readEnvInfo(res) {
  try {
    return JSON.parse(fs.readFileSync(path.join(res, "env.json"), "utf8"));
  } catch {
    return null;
  }
}

function describeRoot(root) {
  const browsers = path.join(root, "browsers");
  return {
    root,
    python: path.join(root, pythonRel),
    browsers: fs.existsSync(browsers) ? browsers : null,
  };
}

function findEmbeddedRoot(res) {
  for (const candidate of [res, path.join(res, "env")]) {
    if (fs.existsSync(path.join(candidate, pythonRel))) return candidate;
  }
  return null;
}

async function sha256File(file) {
  const hash = crypto.createHash("sha256");
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest("hex");
}

async function download(url, dest, expectedSize, onProgress) {
  const response = await httpFetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`Download failed (HTTP ${response.status}): ${url}`);
  const total = Number(response.headers.get("content-length")) || expectedSize || 0;
  let received = 0;
  const meter = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length;
      if (total) onProgress(`Downloading the runtime… ${Math.round((received / 1048576))} / ${Math.round(total / 1048576)} MB`, (received / total) * 100);
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(dest));
}

function extract(archive, dest) {
  return new Promise((resolve, reject) => {
    const child = spawn(TAR, ["-xzf", archive, "-C", dest], { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}: ${stderr.slice(-400)}`))));
  });
}

async function install(info, dir, runtimesDir, onProgress, log) {
  const partial = `${dir}.partial`;
  const archive = path.join(runtimesDir, `${info.id}.download`);
  fs.rmSync(partial, { recursive: true, force: true });
  fs.rmSync(archive, { force: true });
  fs.mkdirSync(partial, { recursive: true });

  const local = process.env.PELDRUN_ENV_ARCHIVE;
  if (local) {
    log(`env: using local archive ${local}`);
    fs.copyFileSync(local, archive);
  } else {
    if (!info.url) throw new Error("This build has no runtime download URL (env.json.url is empty).");
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        log(`env: downloading ${info.url} (attempt ${attempt})`);
        await download(info.url, archive, info.size, onProgress);
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        fs.rmSync(archive, { force: true });
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
    if (lastError) throw lastError;
  }

  onProgress("Verifying the runtime…", null);
  const actual = await sha256File(archive);
  if (actual !== info.sha256) {
    fs.rmSync(archive, { force: true });
    throw new Error(`Runtime checksum mismatch (expected ${info.sha256.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`);
  }

  onProgress("Unpacking the runtime…", null);
  await extract(archive, partial);
  if (!fs.existsSync(path.join(partial, pythonRel))) throw new Error("Runtime archive does not contain the interpreter");
  fs.writeFileSync(path.join(partial, ".ok"), info.id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(partial, dir);
  fs.rmSync(archive, { force: true });
}

/**
 * @returns {Promise<{root:string, python:string, browsers:string|null, id:string|null, embedded:boolean}>}
 */
async function ensureEnv({ res, userData, onProgress = () => {}, log = () => {} }) {
  const info = readEnvInfo(res);
  const embedded = findEmbeddedRoot(res);
  if (embedded) return { ...describeRoot(embedded), id: info ? info.id : null, embedded: true };

  if (!info) throw new Error("env.json is missing and no embedded Python was found");
  const runtimesDir = path.join(userData, "runtimes");
  const dir = path.join(runtimesDir, info.id);
  fs.mkdirSync(runtimesDir, { recursive: true });

  if (!fs.existsSync(path.join(dir, ".ok"))) {
    await install(info, dir, runtimesDir, onProgress, log);
  }
  return { ...describeRoot(dir), id: info.id, embedded: false };
}

/** Remove runtimes that no installed app version needs any more. Call after a healthy start. */
function pruneRuntimes(userData, keepId) {
  const runtimesDir = path.join(userData, "runtimes");
  if (!keepId || !fs.existsSync(runtimesDir)) return;
  for (const name of fs.readdirSync(runtimesDir)) {
    if (name === keepId) continue;
    fs.rmSync(path.join(runtimesDir, name), { recursive: true, force: true });
  }
}

module.exports = { ensureEnv, pruneRuntimes };
