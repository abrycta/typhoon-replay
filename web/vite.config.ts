import { execSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";

import { lingui } from "@lingui/vite-plugin";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

import { fixtures } from "./scripts/vite-fixtures.ts";
import { akariThemeInit } from "./scripts/vite-theme-init.ts";

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
  plugins: [
    tanstackRouter({ target: "react", autoCodeSplitting: true, routesDirectory: "src/routes", generatedRouteTree: "src/routeTree.gen.ts" }),
    react(),
    // Lingui macros (t, Trans, msg) compile to message ids at build time.
    babel({ plugins: ["@lingui/babel-plugin-lingui-macro"], include: /\/src\/.*\.[jt]sx?(\?.*)?$/ }),
    lingui(),
    tailwindcss(),
    // Serves web/fixtures/ (the sample dataset) at /fixtures/ with HTTP range support, like the
    // Hugging Face host, and copies it into the build as the fallback data source.
    fixtures(),
    // Akari's pre-paint theme script (shared krtmtthw.dev theme), served from our own origin.
    akariThemeInit(),
  ],
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
  worker: { format: "es" },
  // MapLibre 6 resolves its worker file relative to its own module; pre-bundling breaks that in dev.
  optimizeDeps: { exclude: ["maplibre-gl"], include: ["comlink"] },
  build: {
    outDir: "dist",
    // Hashed file names under /assets/ get the immutable cache rule in _headers.
    assetsDir: "assets",
    sourcemap: true,
    target: "es2023",
    chunkSizeWarningLimit: 1100, // maplibre-gl is one ~1 MB chunk, loaded only with a map
    // The frozen embed krtmtthw.dev frames is a second page of the same build, so it shares the app's hashed
    // chunks (React, Akari, MapLibre): served at /embed/storm/<sid> (src/embed, scripts/build-embed.mjs).
    rolldownOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        embed: fileURLToPath(new URL("./embed/storm/2013306N07162.html", import.meta.url)),
      },
    },
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "node",
    setupFiles: ["src/test/setup.ts"],
    maxWorkers: 2,
  },
});
