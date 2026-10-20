// MSW handlers for mock mode (`?backend=mock`) and the unit tests. Typed against the generated contract
// (openapi-msw), so a contract change that breaks the mock breaks the typecheck. Responses are the
// contract's own named examples (src/api/generated/examples.json), chosen by the request where the
// contract has several (Tacloban / Naha).
import { delay } from "msw";
import { createOpenApiHttp } from "openapi-msw";

import examplesJson from "../generated/examples.json";
import type { components, paths } from "../generated/schema";

type S = components["schemas"];

interface Examples {
  contractVersion: string;
  operations: Record<string, { responses: Record<string, Record<string, Record<string, unknown>>> }>;
}
const examples = examplesJson as Examples;

function example<T>(op: string, name?: string, status = "200"): T {
  const media = examples.operations[op]?.responses[status];
  const named = media ? Object.values(media)[0] : undefined;
  if (!named) throw new Error(`no example for ${op} ${status}`);
  return structuredClone((name ? named[name] : Object.values(named)[0]) as T);
}

export const MOCK_BASE = "*/api/mock";
const http = createOpenApiHttp<paths>({ baseUrl: MOCK_BASE });

let seq = 0;
function headers(extra: Record<string, string> = {}): HeadersInit {
  return {
    "X-Backend-Impl": "mock",
    "X-Backend-Version": "0.0.0-msw",
    "X-Contract-Version": examples.contractVersion,
    "X-Request-Id": `mock-${++seq}`,
    "Cache-Control": "no-store",
    Vary: "Accept-Encoding",
    ...extra,
  };
}

function problem(status: number, code: string, title: string, detail?: string) {
  return {
    type: `https://typhoon-replay.pages.dev/problems/${code}`,
    title,
    status,
    code,
    detail,
    requestId: `mock-${seq}`,
  } as S["Problem"];
}

const PLACES: Record<string, string> = { "PH-0831600000": "tacloban", "JP-47201": "naha" };
const lc = (s: string | null | undefined) => (s ?? "").toLowerCase();

export const handlers = [
  http.get("/healthz", async ({ response }) => {
    await delay(80);
    return response(200).json({ status: "ok", impl: "mock" }, { headers: headers() });
  }),

  http.get("/v1/meta", async ({ response }) => {
    await delay(60);
    return response(200).json({ ...example<S["Meta"]>("getMeta"), impl: "mock", implVersion: "0.0.0-msw" }, { headers: headers() });
  }),

  http.get("/v1/places/search", async ({ query, response }) => {
    await delay(120);
    const q = lc(query.get("q")).trim();
    if (q.length < 1) {
      return response(400).json(problem(400, "validation", "Request validation failed", "q is required"), {
        headers: headers({ "Content-Type": "application/problem+json" }),
      });
    }
    const country = query.get("country");
    const items = ["tacloban", "naha"]
      .flatMap((n) => example<S["PlaceSearchResults"]>("searchPlaces", n).items)
      .filter((p, i, all) => all.findIndex((x) => x.id === p.id) === i)
      .filter((p) => [p.name, p.nameJa, p.admin1, p.admin2].some((x) => lc(x).includes(q)))
      .filter((p) => !country || p.country === country);
    return response(200).json({ items }, { headers: headers() });
  }),

  http.get("/v1/places/{placeId}", async ({ params, response }) => {
    await delay(80);
    if (params.placeId !== "PH-0831600000") {
      return response(404).json(problem(404, "not-found", "Not found"), { headers: headers({ "Content-Type": "application/problem+json" }) });
    }
    return response(200).json(example<S["PlaceDetail"]>("getPlace", "tacloban"), { headers: headers() });
  }),

  http.get("/v1/places/{placeId}/storms", async ({ params, query, response }) => {
    await delay(150);
    const name = PLACES[params.placeId];
    const radiusKm = Number(query.get("radiusKm") ?? 100) as S["StormHitPage"]["radiusKm"];
    const page: S["StormHitPage"] = name ? { ...example<S["StormHitPage"]>("listPlaceStorms", name), radiusKm } : { items: [], radiusKm };
    return response(200).json(page, { headers: headers() });
  }),

  http.get("/v1/places/nearest", async ({ response }) => {
    await delay(80);
    return response(200).json(example<S["NearestPlace"]>("getNearestPlace"), { headers: headers() });
  }),

  http.get("/v1/storms/{sid}/places", async ({ params, query, response }) => {
    await delay(120);
    const radiusKm = Number(query.get("radiusKm") ?? 200) as S["PlaceHitPage"]["radiusKm"];
    const page: S["PlaceHitPage"] = params.sid === "2013306N07162" ? example<S["PlaceHitPage"]>("listStormPlaces") : { items: [], radiusKm };
    return response(200).json(page, { headers: headers() });
  }),

  http.get("/v1/storms", async ({ query, response }) => {
    await delay(100);
    const q = lc(query.get("q"));
    const page = example<S["StormPage"]>("listStorms", q.includes("yolanda") ? "yolanda" : "latest");
    return response(200).json(page, { headers: headers() });
  }),

  http.get("/v1/storms/{sid}", async ({ params, response }) => {
    await delay(80);
    if (params.sid !== "2013306N07162") {
      return response(404).json(problem(404, "not-found", "Not found"), { headers: headers({ "Content-Type": "application/problem+json" }) });
    }
    return response(200).json(example<S["StormDetail"]>("getStorm"), { headers: headers() });
  }),

  http.get("/v1/me", async ({ response }) =>
    response(401).json(problem(401, "unauthenticated", "Sign-in required"), { headers: headers({ "Content-Type": "application/problem+json" }) }),
  ),
];
