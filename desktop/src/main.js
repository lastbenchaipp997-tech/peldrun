"use strict";

/**
 * PELDRUN desktop shell.
 *
 * Starts two local child processes and shows the UI in a BrowserWindow:
 *   1. the FastAPI backend (embedded Python, uvicorn, omweb.main:app)
 *   2. the Next.js standalone server (run with Electron's own Node)
 *
 * Both listen on 127.0.0.1 only. Ports are fixed (see ports.json) because the
 * Next.js rewrites that proxy /api/* to the backend are baked in at build time.
 *
 * CLI flags (CI / diagnostics):
 *   --smoke-test=<file>        start everything, write OK/FAIL to <file>, exit
 *   --smoke-screenshot=<png>   with --smoke-test: also render the UI and save a screenshot
 *
 * Env vars: PELDRUN_ENV_ARCHIVE (local env archive), PELDRUN_DISABLE_UPDATES=1
 */

const { app, BrowserWindow, dialog, shell } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const ports = require("./ports.json");
const { ensureEnv, pruneRuntimes } = require("./env");
const { setupAutoUpdate } = require("./update");

const IS_WIN = process.platform === "win32";
const BACKEND_PORT = ports.backend;
const FRONTEND_PORT = ports.frontend;
const FRONTEND_ORIGIN = `http://127.0.0.1:${FRONTEND_PORT}`;
const BACKEND_HEALTH = `http://127.0.0.1:${BACKEND_PORT}/api/health`;

const argValue = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : null;
};
const SMOKE_FILE = argValue("--smoke-test");
const SMOKE_SHOT = argValue("--smoke-screenshot");

// Packaged: resources live next to the app. Dev (`npm run dev`): desktop/build.
const RES = app.isPackaged ? process.resourcesPath : path.join(__dirname, "..", "build");

// Writable runtime tree. The backend derives PROJECT_ROOT from its own location
// (<root>/backend/omweb/config.py) and writes <root>/config at import time, so
// the code is copied into a writable folder instead of running from the
// read-only install directory.
const USER_DATA = app.getPath("userData");
const HOME = path.join(USER_DATA, "peldrun-home");
const LOG_DIR = path.join(USER_DATA, "logs");

const children = new Map(); // name -> ChildProcess
let mainWindow = null;
let splashLoaded = Promise.resolve();
let shuttingDown = false;
let runtime = null; // { python, browsers, id, embedded }

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(message) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, "desktop.log"), `${new Date().toISOString()} ${message}\n`);
  } catch {
    /* logging must never crash the app */
  }
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

function httpOk(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitFor(url, name, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const child = children.get(name);
    if (!child || child.exitCode !== null) {
      throw new Error(`${name} exited before becoming ready (see ${path.join(LOG_DIR, name + ".log")})`);
    }
    if (await httpOk(url)) return;
    await sleep(400);
  }
  throw new Error(`Timed out waiting for ${name} at ${url}`);
}

function openExternalSafe(url) {
  try {
    const { protocol } = new URL(url);
    if (protocol === "http:" || protocol === "https:" || protocol === "mailto:") shell.openExternal(url);
  } catch {
    /* ignore malformed URLs */
  }
}

/** Update the splash screen text/progress (no-op without a window). */
function setSplash(message, percent) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const pct = percent == null ? "null" : String(Math.max(0, Math.min(100, Math.round(percent))));
  const js = `(()=>{var m=document.getElementById('msg');if(m)m.textContent=${JSON.stringify(message)};` +
    `var p=${pct},t=document.getElementById('track'),b=document.getElementById('bar');` +
    `if(t&&b){t.style.visibility=p===null?'hidden':'visible';if(p!==null)b.style.width=p+'%';}})()`;
  splashLoaded.then(() => mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.executeJavaScript(js)).catch(() => {});
}

// ---------------------------------------------------------------------------
// runtime files (writable copy of backend code + seeded config)
// ---------------------------------------------------------------------------

/** Copy the SQLite databases aside before a new app version touches them. Keeps the last 3. */
function backupDatabases(fromVersion) {
  try {
    const storage = path.join(HOME, "storage");
    if (!fs.existsSync(storage)) return;
    const files = fs.readdirSync(storage).filter((n) => /\.(db|sqlite3?)(-wal|-shm)?$/i.test(n));
    if (!files.length) return;
    const root = path.join(USER_DATA, "backups");
    const dest = path.join(root, `${fromVersion || "unknown"}-${Date.now()}`);
    fs.mkdirSync(dest, { recursive: true });
    for (const f of files) fs.copyFileSync(path.join(storage, f), path.join(dest, f));
    const all = fs
      .readdirSync(root)
      .map((n) => ({ n, t: fs.statSync(path.join(root, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const old of all.slice(3)) fs.rmSync(path.join(root, old.n), { recursive: true, force: true });
    log(`backed up ${files.length} database file(s) to ${dest}`);
  } catch (err) {
    log(`database backup failed: ${err.message}`);
  }
}

function syncRuntimeFiles() {
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });

  const marker = path.join(HOME, ".app-version");
  const current = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim() : "";
  const needsSync = !app.isPackaged || current !== app.getVersion() || !fs.existsSync(path.join(HOME, "backend"));

  if (needsSync) {
    if (current && current !== app.getVersion()) backupDatabases(current);
    const dst = path.join(HOME, "backend");
    if (fs.existsSync(dst)) {
      for (const entry of fs.readdirSync(dst)) {
        if (entry === "data") continue; // keep runtime caches
        fs.rmSync(path.join(dst, entry), { recursive: true, force: true });
      }
    }
    fs.cpSync(path.join(RES, "backend"), dst, { recursive: true, force: true, preserveTimestamps: true });
    fs.writeFileSync(marker, app.getVersion());
  }

  // User configuration is seeded once and never overwritten by upgrades.
  const cfgDst = path.join(HOME, "config");
  if (!fs.existsSync(cfgDst) && fs.existsSync(path.join(RES, "config"))) {
    fs.cpSync(path.join(RES, "config"), cfgDst, { recursive: true });
  }
  fs.mkdirSync(path.join(HOME, "storage"), { recursive: true });
}

// ---------------------------------------------------------------------------
// child processes
// ---------------------------------------------------------------------------

function startChild(name, command, args, options) {
  const logPath = path.join(LOG_DIR, `${name}.log`);
  try {
    if (fs.existsSync(logPath)) fs.renameSync(logPath, `${logPath}.1`);
  } catch {
    /* best effort */
  }
  const fd = fs.openSync(logPath, "a");
  const child = spawn(command, args, {
    ...options,
    stdio: ["ignore", fd, fd],
    windowsHide: true,
    detached: !IS_WIN, // own process group on POSIX so the whole tree can be killed
  });
  fs.closeSync(fd);
  children.set(name, child);
  child.on("exit", (code, signal) => {
    try {
      fs.appendFileSync(logPath, `\n[desktop] ${name} exited code=${code} signal=${signal}\n`);
    } catch {
      /* ignore */
    }
    if (!shuttingDown && (name === "backend" || name === "frontend") && !SMOKE_FILE) {
      dialog.showErrorBox("PELDRUN", `The ${name} process stopped unexpectedly.\n\nLogs: ${LOG_DIR}`);
      app.exit(1);
    }
  });
  return child;
}

function killTree(child, signal = "SIGTERM") {
  if (!child || child.exitCode !== null || !child.pid) return;
  try {
    if (IS_WIN) {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {
    /* already gone */
  }
}

async function stopAll() {
  if (shuttingDown) return;
  shuttingDown = true;
  const all = [...children.values()];
  all.forEach((c) => killTree(c, "SIGTERM"));
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && all.some((c) => c.exitCode === null && c.signalCode === null)) {
    await sleep(100);
  }
  all.forEach((c) => {
    if (c.exitCode === null && c.signalCode === null) killTree(c, "SIGKILL");
  });
}

function browsersDir() {
  return runtime.browsers || path.join(USER_DATA, "browsers");
}

function backendEnv() {
  return {
    ...process.env,
    PYTHONUNBUFFERED: "1",
    PYTHONUTF8: "1",
    PYTHONNOUSERSITE: "1",
    PELDRUN_STORAGE_ROOT: path.join(HOME, "storage"),
    PLAYWRIGHT_BROWSERS_PATH: browsersDir(),
  };
}

function startBackend() {
  // Same bootstrap as start-backend.ps1: Proactor loop on Windows, plain uvicorn elsewhere.
  const code = [
    "import asyncio, sys, uvicorn",
    IS_WIN ? "asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())" : null,
    `uvicorn.run('omweb.main:app', host='127.0.0.1', port=${BACKEND_PORT}, reload=False)`,
  ]
    .filter(Boolean)
    .join("\n");
  return startChild("backend", runtime.python, ["-c", code], {
    cwd: path.join(HOME, "backend"),
    env: backendEnv(),
  });
}

function startFrontend() {
  return startChild("frontend", process.execPath, [path.join(RES, "frontend", "server.js")], {
    cwd: path.join(RES, "frontend"),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1", // run Electron's binary as plain Node
      NODE_ENV: "production",
      PORT: String(FRONTEND_PORT),
      HOSTNAME: "127.0.0.1",
      NEXT_TELEMETRY_DISABLED: "1",
    },
  });
}

/** Fallback only: the env archive normally already contains Chromium. */
function ensureBrowsersInBackground() {
  try {
    if (runtime.browsers) return;
    const dir = browsersDir();
    if (fs.existsSync(dir) && fs.readdirSync(dir).some((n) => n.startsWith("chromium"))) return;
    startChild("playwright-install", runtime.python, ["-m", "playwright", "install", "chromium"], {
      cwd: path.join(HOME, "backend"),
      env: backendEnv(),
    });
  } catch {
    /* the browser tool simply stays unavailable until installed */
  }
}

// ---------------------------------------------------------------------------
// window
// ---------------------------------------------------------------------------

function createWindow(show = true) {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show,
    title: "PELDRUN",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(FRONTEND_ORIGIN)) return { action: "allow" };
    openExternalSafe(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(FRONTEND_ORIGIN) && !url.startsWith("file://")) {
      event.preventDefault();
      openExternalSafe(url);
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  splashLoaded = mainWindow.loadFile(path.join(__dirname, "splash.html"));
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

function finishSmoke(ok, message) {
  try {
    fs.writeFileSync(SMOKE_FILE, ok ? "OK\n" : `FAIL: ${message}\n`);
  } catch {
    /* nothing else we can do */
  }
  stopAll().finally(() => app.exit(ok ? 0 : 1));
}

async function ensureRuntimeWithRetry() {
  for (;;) {
    try {
      return await ensureEnv({ res: RES, userData: USER_DATA, onProgress: setSplash, log });
    } catch (err) {
      log(`runtime setup failed: ${err.message}`);
      if (SMOKE_FILE) throw err;
      const { response } = await dialog.showMessageBox(mainWindow || undefined, {
        type: "error",
        buttons: ["Retry", "Quit"],
        defaultId: 0,
        cancelId: 1,
        title: "PELDRUN",
        message: "The PELDRUN runtime could not be downloaded or verified.",
        detail: `${err.message}\n\nCheck your internet connection and try again.`,
      });
      if (response !== 0) throw err;
    }
  }
}

async function takeScreenshot() {
  createWindow(true);
  await mainWindow.loadURL(FRONTEND_ORIGIN);
  await sleep(4000);
  const image = await mainWindow.webContents.capturePage();
  fs.writeFileSync(SMOKE_SHOT, image.toPNG());
}

async function boot() {
  try {
    for (const [label, port] of [["backend", BACKEND_PORT], ["frontend", FRONTEND_PORT]]) {
      if (!(await isPortFree(port))) {
        throw new Error(`Port ${port} (${label}) is already in use. Close the other PELDRUN instance or the program using it.`);
      }
    }

    if (!SMOKE_FILE) createWindow();
    setSplash("Preparing PELDRUN…", null);
    syncRuntimeFiles();
    runtime = await ensureRuntimeWithRetry();

    setSplash("Starting PELDRUN…", null);
    startBackend();
    startFrontend();
    await waitFor(BACKEND_HEALTH, "backend", 180_000);
    await waitFor(`${FRONTEND_ORIGIN}/`, "frontend", 120_000);
    if (!runtime.embedded) pruneRuntimes(USER_DATA, runtime.id);

    if (SMOKE_FILE) {
      // The proxy path is what the UI depends on, so verify it too.
      if (!(await httpOk(`${FRONTEND_ORIGIN}/api/health`))) {
        throw new Error("Frontend is up but /api/health is not proxied to the backend");
      }
      if (SMOKE_SHOT) await takeScreenshot();
      return finishSmoke(true);
    }

    if (mainWindow) mainWindow.loadURL(FRONTEND_ORIGIN);
    ensureBrowsersInBackground();
    setupAutoUpdate({ getWindow: () => mainWindow, stopAll, log });
  } catch (err) {
    log(`boot failed: ${err.message}`);
    if (SMOKE_FILE) return finishSmoke(false, err.message);
    dialog.showErrorBox("PELDRUN failed to start", `${err.message}\n\nLogs: ${LOG_DIR}`);
    await stopAll();
    app.exit(1);
  }
}

if (!app.requestSingleInstanceLock() && !SMOKE_FILE) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(boot);

  // The app hosts the servers, so closing the window quits it on every platform.
  app.on("window-all-closed", () => app.quit());

  app.on("before-quit", (event) => {
    if (shuttingDown) return;
    event.preventDefault();
    stopAll().finally(() => app.exit(0));
  });
}
