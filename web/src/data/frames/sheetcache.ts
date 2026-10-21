// Browser cache for WebP frame sheets (Cache Storage), keyed by the sheet's stable URL.
//
// Sheets live on the Hugging Face dataset (resolve/main/frames/...). HF answers each request with a no-store 302
// to a signed CDN URL that changes every time, so the HTTP cache never reuses a sheet and every visit downloads
// them all again. The file names are content-addressed (sha256 prefix): a URL's bytes never change, so a copy
// kept here never goes stale and needs no revalidation.
//
// The cache is best-effort. Every operation swallows its errors (Cache Storage is missing or throws in private
// windows and non-secure contexts), writes happen after the bytes are already in hand, and nothing here can stop
// a sheet from loading over the network.

/** Bump to drop every stored sheet (older caches with the same prefix are deleted on first use). */
export const SHEET_CACHE_PREFIX = "replay-frames-";
export const SHEET_CACHE_NAME = `${SHEET_CACHE_PREFIX}v1`;

/**
 * 200 MB. A storm's sheets average about 2.8 MB (SPIKE.md: about 5.7 GB for 2,058 storms) and the largest are
 * around 15-20 MB, so this keeps several dozen storms: a long session of browsing and comparing replays. It stays
 * well inside every browser's per-origin quota (Chromium and Firefox allow a share of free disk; Safari prompts or
 * evicts above about 1 GB) so it does not crowd out the rest of the site's storage on a small phone.
 */
export const SHEET_CACHE_BUDGET = 200 * 1024 * 1024;

const STORED_AT = "x-replay-stored-at";
const SIZE = "x-replay-bytes";

export interface SheetCacheOptions {
  caches?: CacheStorage;
  name?: string;
  budget?: number;
  now?: () => number;
}

export class SheetCache {
  private readonly name: string;
  private readonly budget: number;
  private readonly now: () => number;
  private opened?: Promise<Cache | undefined>;
  /** Writes and evictions run one after another, so concurrent puts never evict twice for the same bytes. */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly storage: CacheStorage, opts: Omit<SheetCacheOptions, "caches"> = {}) {
    this.name = opts.name ?? SHEET_CACHE_NAME;
    this.budget = opts.budget ?? SHEET_CACHE_BUDGET;
    this.now = opts.now ?? Date.now;
  }

  private open(): Promise<Cache | undefined> {
    this.opened ??= (async () => {
      try {
        const cache = await this.storage.open(this.name);
        void this.dropOldVersions();
        return cache;
      } catch {
        return undefined; // e.g. SecurityError in a private window: plain fetch from now on
      }
    })();
    return this.opened;
  }

  private async dropOldVersions(): Promise<void> {
    try {
      for (const k of await this.storage.keys()) if (k.startsWith(SHEET_CACHE_PREFIX) && k !== this.name) await this.storage.delete(k);
    } catch {
      /* best effort */
    }
  }

  /** The stored bytes for `url`, or undefined (not stored, or the cache is unavailable). */
  async get(url: string): Promise<{ bytes: ArrayBuffer; type: string } | undefined> {
    try {
      const cache = await this.open();
      const hit = await cache?.match(url);
      if (!hit) return undefined;
      return { bytes: await hit.arrayBuffer(), type: hit.headers.get("Content-Type") ?? "" };
    } catch {
      return undefined;
    }
  }

  /** Forget `url` (a stored copy that failed to decode). Never rejects. */
  async delete(url: string): Promise<void> {
    try {
      await (await this.open())?.delete(url);
    } catch {
      /* best effort */
    }
  }

  /**
   * Stores a copy of `bytes` (copied synchronously, so the caller may hand the buffer on at once) and then evicts
   * the oldest entries until the cache is within budget. Never rejects.
   */
  put(url: string, bytes: ArrayBuffer, type: string): Promise<void> {
    const size = bytes.byteLength;
    if (size === 0 || size > this.budget) return Promise.resolve();
    // The Response constructor copies the bytes now (Fetch: "extract a body" copies a BufferSource).
    const body = new Response(bytes, {
      headers: { "Content-Type": type, [SIZE]: String(size), [STORED_AT]: String(this.now()) },
    });
    this.queue = this.queue.then(async () => {
      try {
        const cache = await this.open();
        if (!cache) return;
        await cache.put(url, body);
        await this.evict(cache);
      } catch {
        /* quota exceeded or cache gone: playback does not depend on it */
      }
    });
    return this.queue;
  }

  private async evict(cache: Cache): Promise<void> {
    const entries: { req: Request; size: number; at: number }[] = [];
    for (const req of await cache.keys()) {
      const res = await cache.match(req);
      if (!res) continue;
      entries.push({ req, size: Number(res.headers.get(SIZE)) || 0, at: Number(res.headers.get(STORED_AT)) || 0 });
    }
    let total = entries.reduce((s, e) => s + e.size, 0);
    if (total <= this.budget) return;
    entries.sort((a, b) => a.at - b.at);
    for (const e of entries) {
      if (total <= this.budget) break;
      await cache.delete(e.req);
      total -= e.size;
    }
  }
}

let shared: SheetCache | null | undefined;

/** The worker's shared cache, or null where Cache Storage is unavailable (non-secure context, old browser). */
export function defaultSheetCache(): SheetCache | null {
  if (shared === undefined) {
    let storage: CacheStorage | undefined;
    try {
      storage = typeof caches === "undefined" ? undefined : caches;
    } catch {
      storage = undefined;
    }
    shared = storage ? new SheetCache(storage) : null;
  }
  return shared;
}
