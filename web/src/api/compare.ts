// "Same result?": compare response bodies from different implementations after removing what may
// legitimately differ between them (identity, build and paging tokens) and formatting noise.

/** Keys that name the implementation or a request rather than the data. */
const VOLATILE = new Set(["impl", "implVersion", "commit", "requestId", "instance", "nextCursor"]);
/** In /v1/meta (an object carrying `impl`), `startedAt` is the process start time, not a storm's. */
const META_ONLY = new Set(["startedAt"]);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * Canonical form of a JSON body: object keys sorted, volatile keys dropped, numbers rounded to 9 significant
 * digits (float formatting differs between languages), RFC 3339 times as UTC with whole seconds.
 */
export function normaliseBody(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normaliseBody);
  if (typeof v === "number") return Number.isInteger(v) ? v : Number(v.toPrecision(9));
  if (typeof v === "string" && ISO.test(v)) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? new Date(Math.round(t / 1000) * 1000).toISOString().replace(".000Z", "Z") : v;
  }
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const isMeta = "impl" in o;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) {
      if (VOLATILE.has(k) || (isMeta && META_ONLY.has(k)) || o[k] === null || o[k] === undefined) continue;
      out[k] = normaliseBody(o[k]);
    }
    return out;
  }
  return v;
}

/** Stable fingerprint of a body for equality checks. */
export const bodyKey = (v: unknown): string => JSON.stringify(normaliseBody(v));

export type MatchState = "same" | "differs" | "alone";

/**
 * Per lane: "same" when another answered lane has an equal normalised body, "differs" when others answered
 * and none agrees, "alone" while it is the only answer. Lanes without an answer get no entry.
 */
export function matchStates(bodies: Readonly<Record<string, unknown>>): Record<string, MatchState> {
  const keys = Object.fromEntries(Object.entries(bodies).map(([id, b]) => [id, bodyKey(b)]));
  const ids = Object.keys(keys);
  const out: Record<string, MatchState> = {};
  for (const id of ids) {
    const others = ids.filter((x) => x !== id);
    out[id] = others.length === 0 ? "alone" : others.some((x) => keys[x] === keys[id]) ? "same" : "differs";
  }
  return out;
}
