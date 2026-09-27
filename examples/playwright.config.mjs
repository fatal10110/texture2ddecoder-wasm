// Playwright config for the one browser smoke test (plan §5): examples/cdn.html,
// served by serve.mjs with this repo's builds standing in for jsDelivr.
//
//   npm run build && npm run test:smoke          (needs the WASM in
//   packages/texture2ddecoder-wasm/wasm/ and a Playwright Chromium)
import { defineConfig, devices } from "@playwright/test";

const PORT = 8135;

export default defineConfig({
  testDir: "tests",
  outputDir: "test-results",
  forbidOnly: Boolean(process.env.CI),
  reporter: "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node serve.mjs",
    env: { PORT: String(PORT) },
    url: `http://localhost:${PORT}/examples/cdn.html`,
    reuseExistingServer: !process.env.CI,
  },
});
