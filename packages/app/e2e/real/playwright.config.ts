import { fileURLToPath } from "node:url"
import { defineConfig, devices } from "@playwright/test"
import { serverURL } from "./fixture"

// The real backend suite runs the compiled server, which serves the app build it embeds from its own origin.
// The suite therefore points the browser at the server, not at a static file server.
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  outputDir: "../test-results/real",
  timeout: 120_000,
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  expect: { timeout: 15_000 },
  reporter: [["line"]],
  webServer: {
    command: "bun e2e/real/serve.ts",
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    url: serverURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  use: {
    baseURL: serverURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    // The PWA worker precaches the whole build; the service-worker suite covers it.
    serviceWorkers: "block",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
})
