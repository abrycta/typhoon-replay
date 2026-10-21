// Cloudflare Worker entry: replay-api-node (DECISIONS, "Update 2026-10-22: hosting the Go, Node and Rust backends").
import { app } from './app';

export default { fetch: app.fetch } satisfies ExportedHandler<import('./platform/env').Env>;
