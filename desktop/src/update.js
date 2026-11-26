"use strict";

/**
 * In-app updates for the shell + code layers via electron-updater
 * (GitHub Releases: latest*.yml published by electron-builder).
 *
 * - Disabled in dev, and when PELDRUN_DISABLE_UPDATES=1.
 * - Windows (NSIS) and Linux (AppImage) download only the changed blocks
 *   (blockmap); macOS downloads the full zip. .deb packages are not self-updating.
 * - The runtime (Python env) is NOT part of this: a new app version that needs a
 *   different env downloads it on first start (see env.js).
 * - Before installing, the child processes are stopped; otherwise the Windows
 *   installer cannot replace files that are still in use.
 *
 * UNTESTED here: needs a signed release on a real channel.
 */

const { app, dialog } = require("electron");

const SIX_HOURS = 6 * 60 * 60 * 1000;

function setupAutoUpdate({ getWindow, stopAll, log }) {
  if (!app.isPackaged || process.env.PELDRUN_DISABLE_UPDATES === "1") return;

  let autoUpdater;
  try {
    ({ autoUpdater } = require("electron-updater"));
  } catch (err) {
    log(`updater unavailable: ${err.message}`);
    return;
  }

  if (process.platform === "darwin" && process.arch === "arm64") {
    autoUpdater.channel = "arm64"; // matches publish.channel in electron-builder.config.cjs
    autoUpdater.allowDowngrade = false;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false; // we stop the servers first, then install explicitly
  autoUpdater.logger = { info: log, warn: log, error: log, debug: () => {} };

  autoUpdater.on("update-downloaded", async (info) => {
    const win = getWindow();
    const { response } = await dialog.showMessageBox(win || undefined, {
      type: "info",
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      cancelId: 1,
      title: "PELDRUN update",
      message: `Version ${info.version} is ready to install.`,
      detail: "PELDRUN will close and restart to finish the update.",
    });
    if (response !== 0) return;
    try {
      await stopAll();
      autoUpdater.quitAndInstall(false, true);
    } catch (err) {
      log(`quitAndInstall failed: ${err.message}`);
    }
  });
  autoUpdater.on("error", (err) => log(`updater error: ${err.message}`));

  const check = () => autoUpdater.checkForUpdates().catch((err) => log(`update check failed: ${err.message}`));
  setTimeout(check, 20_000); // let the app finish starting first
  setInterval(check, SIX_HOURS);
}

module.exports = { setupAutoUpdate };
