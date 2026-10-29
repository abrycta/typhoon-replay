// Source maps are not published (web/vite.config.ts sourcemap: false). Builds before that published
// /assets/*.js.map with `Cache-Control: immutable`, and Pages' CDN can keep serving those cached copies after a
// new deployment. Routing /assets/*.map to a Function (web/public/_routes.json) answers them before the asset
// cache, so no map is ever served. Anything else under /assets/ goes on to the static asset unchanged.

export function isSourceMap(pathname: string): boolean {
  return pathname.startsWith("/assets/") && pathname.endsWith(".map");
}

export function sourceMapGone(): Response {
  return new Response("Not found\n", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}
