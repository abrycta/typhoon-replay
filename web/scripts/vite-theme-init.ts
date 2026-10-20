// Vite plugin: serve Akari's pre-paint theme script at /theme-init.js (dev and preview) and emit it into
// the build, so index.html can load it from the app's own origin (CSP script-src 'self').
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import type { Connect, Plugin } from "vite";

const require = createRequire(import.meta.url);

export function akariThemeInit(path = "/theme-init.js"): Plugin {
  const source = () =>
    readFileSync(
      require.resolve("@abrycta/akari/assets/theme-init.js"),
      "utf8",
    );
  const serve: Connect.NextHandleFunction = (req, res, next) => {
    if (req.url?.split("?")[0] !== path) return next();
    res.setHeader("Content-Type", "text/javascript; charset=utf-8");
    res.end(source());
  };
  return {
    name: "akari-theme-init",
    configureServer: (server) => void server.middlewares.use(serve),
    configurePreviewServer: (server) => void server.middlewares.use(serve),
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: path.slice(1),
        source: source(),
      });
    },
  };
}
