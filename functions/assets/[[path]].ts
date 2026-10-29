// Cloudflare Pages Function for /assets/*.map only (web/public/_routes.json): always 404, never a cached map.
// See edge/src/sourcemaps.ts. Any other path that reaches it is passed on to the static asset.
import { isSourceMap, sourceMapGone } from "../../edge/src/sourcemaps";

export const onRequest: PagesFunction = (context) =>
  isSourceMap(new URL(context.request.url).pathname) ? sourceMapGone() : context.next();
