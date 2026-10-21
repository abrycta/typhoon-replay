import { z } from "zod/mini";

/**
 * Runtime configuration, read from /config.json at startup (build once, deploy anywhere:
 * only this file changes per host). See public/config.json for the shipped values.
 */
export const BackendId = z.enum(["java", "node", "rust", "go"]);
export type BackendId = z.infer<typeof BackendId>;

const Backend = z.object({
  id: BackendId,
  label: z.string(),
  /** Base URL in front of the contract paths (`/v1/...`, `/healthz`), e.g. `/api/java`. */
  baseUrl: z.string(),
});
export type BackendConfig = z.infer<typeof Backend>;

const Data = z.object({
  /** Dataset root (any static host with CORS). Trailing slash added if missing. */
  baseUrl: z.string(),
  /** Pointer file relative to baseUrl naming the current version directory. */
  pointer: z._default(z.string(), "latest.json"),
  /** Tried in order when the primary dataset is unreachable (e.g. the bundled fixture). */
  fallbackBaseUrls: z._default(z.array(z.string()), []),
});

export const AppConfig = z.object({
  siteUrl: z._default(z.string(), "https://replay.krtmtthw.dev"),
  data: Data,
  backends: z.array(Backend).check(z.minLength(1)),
  defaultBackend: z._default(BackendId, "java"),
});
export type AppConfig = z.infer<typeof AppConfig>;

export const withSlash = (u: string) => (u.endsWith("/") ? u : `${u}/`);

export function parseConfig(json: unknown): AppConfig {
  const cfg = AppConfig.parse(json);
  return {
    ...cfg,
    data: { ...cfg.data, baseUrl: withSlash(cfg.data.baseUrl), fallbackBaseUrls: cfg.data.fallbackBaseUrls.map(withSlash) },
  };
}

export async function loadConfig(url = "/config.json", fetchImpl: typeof fetch = fetch): Promise<AppConfig> {
  // No cache option: it must match the <link rel=preload> in index.html; _headers makes it revalidate.
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`config.json: HTTP ${res.status}`);
  return parseConfig(await res.json());
}
