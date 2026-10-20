import { execSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Commit shown in the footer. CI sets BUILD_SHA (the PR head commit for
// previews); GITHUB_SHA and the local git checkout are fallbacks.
function commitSha(): string {
  const fromEnv = process.env.BUILD_SHA ?? process.env.GITHUB_SHA;
  if (fromEnv) return fromEnv;
  try {
    return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __COMMIT_SHA__: JSON.stringify(commitSha()),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    // A locally linked design system (scripts/link-akari.sh) has its own
    // node_modules; dedupe keeps a single React instance.
    dedupe: ["react", "react-dom"],
  },
  build: {
    outDir: "dist",
    // Hashed file names under /assets/ get the immutable cache rule in _headers.
    assetsDir: "assets",
    sourcemap: true,
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
