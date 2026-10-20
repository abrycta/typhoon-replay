// Tests run inside workerd (Miniflare) via the Workers Vitest integration, so caches.default, Request/Response
// streaming and AbortSignal behave as on Cloudflare. The backend is a fake origin installed over global fetch.
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-10-01",
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    maxWorkers: 2,
  },
});
