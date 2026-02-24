import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e/tests",
  outputDir: "./e2e/test-results",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI
    ? [["html", { outputFolder: "./e2e/playwright-report" }], ["github"]]
    : [["list"]],
  use: {
    baseURL: "http://127.0.0.1:3333",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    // Increase default timeout for dev server cold-compile latency
    navigationTimeout: 15_000,
  },
  projects: [
    {
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile-chrome",
      use: { ...devices["Pixel 5"] },
    },
  ],
  webServer: {
    command: "pnpm dev:next",
    port: 3333,
    env: { PORT: "3333" },
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
