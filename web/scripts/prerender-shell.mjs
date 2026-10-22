// Writes the static page shell (src/app/static-shell.tsx) into dist/index.html's #root, in English and Japanese;
// public/lang-init.js sets <html lang> before the first paint and a two-line style shows the matching one. React's
// first render replaces #root's content in place (createRoot clears it), so the shell needs no script of its own.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const web = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ root: web, configFile: false, logLevel: "error", server: { middlewareMode: true }, appType: "custom", esbuild: { jsx: "automatic" }, resolve: { alias: { "@": `${web}src` } } });
try {
  const { staticShell } = await vite.ssrLoadModule("/src/app/static-shell.tsx");
  const shell = `<div data-static-shell="en">${staticShell("en")}</div><div data-static-shell="ja">${staticShell("ja")}</div>`;
  const file = `${web}dist/index.html`;
  const html = readFileSync(file, "utf8");
  if (!html.includes('<div id="root"></div>')) throw new Error("prerender-shell: no empty #root in dist/index.html");
  const style = `<style>html:not([lang="ja"]) [data-static-shell="ja"], html[lang="ja"] [data-static-shell="en"] { display: none; }</style>\n  </head>`;
  writeFileSync(file, html.replace("</head>", style).replace('<div id="root"></div>', `<div id="root">${shell}</div><!--/root-->`));
  console.log(`prerender-shell: ${Math.round(shell.length / 1024)} kB of static shell in dist/index.html`);
} finally {
  await vite.close();
}
