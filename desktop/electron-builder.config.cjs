"use strict";

/**
 * electron-builder configuration.
 *
 *   PELDRUN_FLAVOR=lite  (default)  shell + code only. The Python environment is
 *                                   downloaded on first start (see src/env.js).
 *   PELDRUN_FLAVOR=full             also embeds Python + Chromium: works offline,
 *                                   several times larger. Not auto-updated.
 */

const fs = require("node:fs");
const path = require("node:path");

const flavor = process.env.PELDRUN_FLAVOR === "full" ? "full" : "lite";
const has = (p) => fs.existsSync(path.join(__dirname, p));

const extraResources = [
  { from: "build/backend", to: "backend" },
  { from: "build/config", to: "config" },
  { from: "build/frontend", to: "frontend" },
  { from: "build/env.json", to: "env.json" },
];
if (flavor === "full") {
  extraResources.push({ from: "build/env/python", to: "python" });
  if (has("build/env/browsers")) extraResources.push({ from: "build/env/browsers", to: "browsers" });
}

const wantsNotarize = Boolean(process.env.APPLE_TEAM_ID && (process.env.APPLE_APP_SPECIFIC_PASSWORD || process.env.APPLE_API_KEY));

module.exports = {
  appId: "ai.peldrun.desktop",
  productName: "PELDRUN",
  copyright: "Copyright © PELDRUN",

  directories: { output: flavor === "full" ? "dist-full" : "dist", buildResources: "build-resources" },

  // Only the tiny Electron shell goes into app.asar. The big runtimes are plain
  // files under <resources>/ so they stay executable.
  files: ["package.json", "src/**"],
  extraResources,
  afterPack: path.join(__dirname, "scripts", "after-pack.cjs"),

  // Both mac architectures are built on separate runners and would overwrite each
  // other's latest-mac.yml. arm64 gets its own channel file (arm64-mac.yml);
  // src/update.js selects the same channel at runtime.
  publish: {
    provider: "github",
    owner: "peldrun",
    repo: "peldrun",
    releaseType: "draft",
    ...(process.platform === "darwin" && process.arch === "arm64" ? { channel: "arm64" } : {}),
  },

  // Same name pattern per flavor; "-full" keeps the offline installers apart from the auto-updated ones.
  artifactName: "${productName}-${version}-${os}-${arch}" + (flavor === "full" ? "-full" : "") + ".${ext}",

  // ---- macOS: signing/notarization are driven by CI secrets (see README) ----
  mac: {
    category: "public.app-category.developer-tools",
    target: ["dmg", "zip"],
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "build-resources/entitlements.mac.plist",
    entitlementsInherit: "build-resources/entitlements.mac.plist",
    notarize: wantsNotarize,
  },

  linux: {
    executableName: "peldrun",
    category: "Development",
    maintainer: "PELDRUN <dev@peldrun.local>",
    target: ["AppImage", "deb"],
  },

  win: { target: ["nsis"] },
  nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true },
};
