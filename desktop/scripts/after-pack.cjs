"use strict";

/**
 * electron-builder drops every `node_modules` directory when it copies
 * extraResources, which removes the Next.js standalone server's dependencies
 * (symptom: "Cannot find module 'next'"). This hook copies the folder back
 * into the packaged app, before code signing runs.
 */

const fs = require("node:fs");
const path = require("node:path");

exports.default = async function afterPack(context) {
  const { appOutDir, electronPlatformName, packager } = context;
  const resources =
    electronPlatformName === "darwin"
      ? path.join(appOutDir, `${packager.appInfo.productFilename}.app`, "Contents", "Resources")
      : path.join(appOutDir, "resources");

  const src = path.join(__dirname, "..", "build", "frontend", "node_modules");
  const dst = path.join(resources, "frontend", "node_modules");
  if (!fs.existsSync(src)) {
    throw new Error(`afterPack: ${src} not found — run "npm run prepare:frontend" first`);
  }

  fs.cpSync(src, dst, { recursive: true, verbatimSymlinks: true });

  if (!fs.existsSync(path.join(dst, "next", "package.json"))) {
    throw new Error("afterPack: next is missing from the packaged frontend");
  }
  console.log(`  • afterPack  restored frontend/node_modules (${electronPlatformName})`);
};
