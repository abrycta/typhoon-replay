import { defineConfig, devices } from "@playwright/test";

// E2E against the production build served by `vite preview` (build first: npm run build).
// External hosts are stubbed in e2e/fixtures.ts so runs are deterministic and offline-safe:
// the Hugging Face dataset answers 404 (the app falls back to the bundled fixture) and the
// OpenFreeMap basemap is unreachable (the app falls back to the bundled coastline).
const PORT = Number(process.env.E2E_PORT ?? 4317);

export default defineConfig({
  testDir: "e2e",
  timeout: 45_000,
  // CI: a hung test or browser fails the run with a message after 7 minutes (the suite takes about 3) instead of using up the job.
  globalTimeout: process.env.CI ? 7 * 60_000 : 0,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 2,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } } }],
  webServer: {
    command: `npx vite preview --port ${PORT} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
