/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";

import { allowedQuery, CONTRACT_QUERY, contractQuery } from "../src/query";

// The contract sources, read as text at build time (no YAML parser needed for these flat files).
const SPEC = import.meta.glob("../../contracts/openapi/openapi.yaml", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const PATHS = import.meta.glob("../../contracts/openapi/paths/*.yaml", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const PARAMS = import.meta.glob("../../contracts/openapi/components/parameters/*.yaml", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const base = (p: string) => p.split("/").pop()!;
const queryName = (yaml: string) => (/^\s*in: query\s*$/m.test(yaml) ? /^\s*name: (\S+)\s*$/m.exec(yaml)?.[1] : undefined);

/** Query parameter names of a path file's GET: inline `- name: x / in: query` items and $refs to parameter files. */
function contractParams(file: string): string[] {
  const get = file.split(/^(?=\S)/m).find((block) => block.startsWith("get:")) ?? "";
  const list = /^ {2}parameters:\n((?: {4}.*\n|\s*\n)*)/m.exec(get)?.[1] ?? "";
  return list
    .split(/^ {4}- /m)
    .slice(1)
    .map((item) => {
      const ref = /^\$ref: \.\.\/components\/parameters\/(\S+)/.exec(item)?.[1];
      return ref ? queryName(Object.entries(PARAMS).find(([p]) => base(p) === ref)![1]) : queryName(item);
    })
    .filter((n): n is string => !!n);
}

describe("query allow-list", () => {
  it("matches the contract: every path's GET query parameters", () => {
    const spec = Object.values(SPEC)[0]!;
    const fromContract: Record<string, string[]> = {};
    for (const [, path, file] of spec.matchAll(/^ {2}(\/\S+):\n {4}\$ref: paths\/(\S+)$/gm)) {
      const params = contractParams(Object.entries(PATHS).find(([p]) => base(p) === file)![1]);
      if (params.length) fromContract[path!] = params;
    }
    expect(Object.keys(fromContract).length).toBeGreaterThan(5);
    expect(Object.fromEntries(Object.entries(CONTRACT_QUERY).map(([k, v]) => [k, [...v]]))).toEqual(fromContract);
  });

  it("knows templated paths and refuses everything on paths without parameters", () => {
    expect([...allowedQuery("/v1/storms/2013306N07162/places")]).toEqual(["radiusKm", "country", "cursor", "limit"]);
    expect(allowedQuery("/v1/meta").size).toBe(0);
    expect(allowedQuery("/v1/storms/x/places/extra").size).toBe(0);
  });

  it("drops unknown parameters, keeps every value of known ones, and leaves clean requests untouched", () => {
    const r = contractQuery(new Request("https://replay.example/api/java/v1/storms?junk=1&season=2013&limit=5&limit=6&cb=x"));
    expect(new URL(r.url).search).toBe("?season=2013&limit=5&limit=6");
    expect(new URL(contractQuery(new Request("https://replay.example/api/go/v1/meta?audit_probe=1")).url).search).toBe("");
    const clean = new Request("https://replay.example/api/java/v1/hits?lat=11&lon=125");
    expect(contractQuery(clean)).toBe(clean);
    const post = new Request("https://replay.example/api/java/v1/storms?junk=1", { method: "POST", body: "{}" });
    expect(contractQuery(post)).toBe(post);
  });

  it("keeps request headers, so conditional reads still work", () => {
    const r = contractQuery(new Request("https://replay.example/api/java/v1/meta?x=1", { headers: { "If-None-Match": 'W/"a"' } }));
    expect(r.headers.get("If-None-Match")).toBe('W/"a"');
  });
});
