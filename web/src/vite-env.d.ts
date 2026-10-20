/// <reference types="vite/client" />

/** Full commit SHA the bundle was built from (see vite.config.ts). */
declare const __COMMIT_SHA__: string;
/** ISO 8601 timestamp of the build. */
declare const __BUILD_TIME__: string;

/** Lingui catalogs, compiled by @lingui/vite-plugin. */
declare module "*.po" {
  export const messages: Record<string, unknown>;
}
