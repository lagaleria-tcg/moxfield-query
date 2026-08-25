import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

if (process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD === "1") {
  console.log("Skipping Playwright browser download");
  process.exit(0);
}

// Hermetic path so Render's build artifact includes the browser binaries.
if (process.env.RENDER && !process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = "0";
}

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const executable = chromium.executablePath();

if (existsSync(executable)) {
  console.log(`Playwright Chromium already present: ${executable}`);
  process.exit(0);
}

console.log("Installing Playwright Chromium…");
const cli = join(dirname(require.resolve("playwright/package.json")), "cli.js");
const result = spawnSync(process.execPath, [cli, "install", "chromium"], {
  stdio: "inherit",
  env: process.env,
});
process.exit(result.status ?? 1);
