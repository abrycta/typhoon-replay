// Vite plugin: serve web/fixtures/ at /fixtures/ (dev and `vite preview`) with HTTP Range support, the
// way the Hugging Face `resolve` host answers, and copy it into dist/fixtures/ on build so the deployed
// app has a fallback dataset while the published one is unavailable.
import { cpSync, createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, normalize, resolve } from "node:path";

import type { Plugin } from "vite";

const TYPES: Record<string, string> = {
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".tyf": "application/octet-stream",
  ".gz": "application/gzip",
};

export function fixtures(dir = resolve(import.meta.dirname, "../fixtures"), prefix = "/fixtures/"): Plugin {
  let outDir = "dist";
  const handler = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (!url.pathname.startsWith(prefix)) return next();
    const rel = normalize(decodeURIComponent(url.pathname.slice(prefix.length)));
    const file = join(dir, rel);
    if (rel.startsWith("..") || !existsSync(file) || !statSync(file).isFile()) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    const size = statSync(file).size;
    const ext = file.slice(file.lastIndexOf("."));
    res.setHeader("Content-Type", TYPES[ext] ?? "application/octet-stream");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-cache");
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    if (m && (m[1] || m[2])) {
      const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
      const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (start >= size || start > end) {
        res.statusCode = 416;
        res.setHeader("Content-Range", `bytes */${size}`);
        res.end();
        return;
      }
      res.statusCode = 206;
      res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
      res.setHeader("Content-Length", String(end - start + 1));
      createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.setHeader("Content-Length", String(size));
    createReadStream(file).pipe(res);
  };
  return {
    name: "typhoon-replay-fixtures",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
    closeBundle() {
      if (existsSync(dir) && existsSync(outDir)) cpSync(dir, join(outDir, prefix), { recursive: true });
    },
  };
}
