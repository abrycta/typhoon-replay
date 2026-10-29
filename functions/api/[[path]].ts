// Cloudflare Pages Function: the same-origin edge proxy for /api/{impl}/*.
// Pages compiles functions/ from the directory `wrangler pages deploy|dev` runs in (the repo root), and
// web/public/_routes.json limits Functions to /api/* (and /assets/*.map, functions/assets), so static assets never invoke this.
// The logic lives in edge/src (tested with the Workers Vitest integration): see edge/README.md.
// Query parameters the contract does not define are dropped first (edge/src/query.ts), so they reach neither the
// cache key nor the backend.
import { type Env, handleProxy } from "../../edge/src/proxy";
import { contractQuery } from "../../edge/src/query";

export const onRequest: PagesFunction<Env> = (context) => handleProxy(contractQuery(context.request), context.env, context);
