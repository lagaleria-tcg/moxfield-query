/**
 * Must be imported before `playwright` so Render looks for browsers inside
 * the deploy artifact (`node_modules/playwright-core/.local-browsers`).
 */
if (process.env.RENDER && !process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = "0";
}
