import { describe, expect, it } from "vitest";

import { SHEET_CACHE_PREFIX, SheetCache } from "./sheetcache";

/** In-memory CacheStorage: just the calls SheetCache makes. */
function fakeCaches() {
  const stores = new Map<string, Map<string, Response>>();
  const cache = (m: Map<string, Response>) =>
    ({
      match: async (req: RequestInfo) => m.get(typeof req === "string" ? req : req.url)?.clone(),
      put: async (req: RequestInfo, res: Response) => void m.set(typeof req === "string" ? req : req.url, res),
      keys: async () => [...m.keys()].map((u) => new Request(u)),
      delete: async (req: RequestInfo) => m.delete(typeof req === "string" ? req : req.url),
    }) as unknown as Cache;
  const storage = {
    open: async (name: string) => cache(stores.get(name) ?? stores.set(name, new Map()).get(name)!),
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
  } as unknown as CacheStorage;
  return { storage, stores };
}

const url = (k: number) => `https://example.org/frames/${k}.webp`;
const bytes = (n: number, fill = 1) => new Uint8Array(n).fill(fill).buffer;

describe("SheetCache", () => {
  it("misses, stores a copy, then hits; evicts the oldest entries past the budget; drops old versions", async () => {
    const { storage, stores } = fakeCaches();
    stores.set(`${SHEET_CACHE_PREFIX}v0`, new Map());
    let t = 0;
    const c = new SheetCache(storage, { budget: 250, now: () => ++t });

    expect(await c.get(url(1))).toBeUndefined();
    const buf = bytes(100, 7);
    const stored = c.put(url(1), buf, "image/webp");
    new Uint8Array(buf).fill(0); // the caller may reuse the buffer at once: the cache kept its own copy
    await stored;
    const hit = await c.get(url(1));
    expect(hit?.type).toBe("image/webp");
    expect(new Uint8Array(hit!.bytes)).toEqual(new Uint8Array(100).fill(7));
    expect(stores.has(`${SHEET_CACHE_PREFIX}v0`)).toBe(false);

    // 100 + 100 + 100 > 250: the oldest (url 1) goes; two concurrent puts evict once between them.
    await Promise.all([c.put(url(2), bytes(100), "image/webp"), c.put(url(3), bytes(100), "image/webp")]);
    expect(await c.get(url(1))).toBeUndefined();
    expect(await c.get(url(2))).toBeDefined();
    expect(await c.get(url(3))).toBeDefined();
    // An entry bigger than the whole budget is never stored (and evicts nothing).
    await c.put(url(4), bytes(300), "image/webp");
    expect(await c.get(url(4))).toBeUndefined();
    expect(await c.get(url(2))).toBeDefined();
  });

  it("degrades to misses when Cache Storage throws (private windows)", async () => {
    const broken = { open: async () => Promise.reject(new DOMException("denied", "SecurityError")) } as unknown as CacheStorage;
    const c = new SheetCache(broken);
    await expect(c.put(url(1), bytes(10), "image/webp")).resolves.toBeUndefined();
    expect(await c.get(url(1))).toBeUndefined();
  });
});
