// What the page asks the backends: three race questions and the explorer's endpoints. Paths are contract
// paths (contracts/openapi) with their parameters filled in; the template is kept for type checking.
import type { ContractPath } from "@/api";
import type { BackendId } from "@/shared/config/config";

import conformanceJson from "./conformance.json";

export const RACE_BACKENDS: readonly BackendId[] = ["java", "node", "rust", "go"];

export const HAIYAN = "2013306N07162";
/** Tacloban City (contract seed place; PSGC 0831600000). */
export const TACLOBAN = "PH-0831600000";

export type QuestionId = "town" | "storm" | "search";

interface Endpoint {
  template: ContractPath | "/healthz";
  path: string;
}

export const QUESTIONS: Record<QuestionId, Endpoint> = {
  town: { template: "/v1/places/{placeId}/storms", path: `/v1/places/${TACLOBAN}/storms?radiusKm=100&sort=closest&limit=50` },
  storm: { template: "/v1/storms/{sid}", path: `/v1/storms/${HAIYAN}` },
  search: { template: "/v1/places/search", path: "/v1/places/search?q=Naha&limit=10" },
};

export type EndpointId = "meta" | "storm" | "hits" | "search" | "healthz";

export const ENDPOINTS: Record<EndpointId, Endpoint> = {
  meta: { template: "/v1/meta", path: "/v1/meta" },
  storm: QUESTIONS.storm,
  hits: { template: "/v1/places/{placeId}/storms", path: `/v1/places/${TACLOBAN}/storms?radiusKm=100` },
  search: QUESTIONS.search,
  healthz: { template: "/healthz", path: "/healthz" },
};

// ---------------------------------------------------------------------------------------------- conformance

export interface PassCount {
  total: number;
  /** Absent when Schemathesis found failures (it then reports unique failures, not passed cases). */
  passed?: number;
  failed: number;
  skipped: number;
}

export interface CiRun {
  id: number;
  url: string;
  sha: string;
  /** YYYY-MM-DD */
  date: string;
}

export interface SchemathesisFailure {
  operation: string;
  code?: string;
  title: string;
}

/** One backend's figures from one CI run on main (contracts/conformance/scripts/summarize.mjs). */
export interface CiConformance {
  run: CiRun;
  /** The Vitest scenario suite. */
  scenarios: PassCount;
  /** The gating Schemathesis run, with the checks it leaves out. */
  generated: PassCount & { excludedChecks: string[] };
  /** The full-config Schemathesis run (every check; informational, does not gate). */
  full?: PassCount & { failures: SchemathesisFailure[] };
}

/** Figures CI does not measure: kept here, by hand. */
interface BackendFacts {
  stack: string;
  /** Observed by hand on Render's free plan, not by CI. */
  coldStartS?: number;
}

const FACTS: Record<BackendId, BackendFacts> = {
  java: { stack: "Spring Boot 4.1 · Java 25", coldStartS: 100 },
  node: { stack: "Hono 4.13 · TypeScript · Workers" },
  rust: { stack: "Axum 0.8 · Rust 1.99 · Workers" },
  go: { stack: "net/http · oapi-codegen · Go 1.27" },
};

export type BackendConformance = BackendFacts & { ci?: CiConformance };

export interface Conformance {
  backends: Record<BackendId, BackendConformance>;
}

/**
 * conformance.json is generated from each backend's latest passing CI run on main (web/scripts/conformance-from-ci.mjs,
 * run by CI before the build); it is imported, so Vite inlines it at build time. A backend without CI figures has no `ci`.
 */
const ciFigures = (conformanceJson as { backends: Partial<Record<BackendId, CiConformance>> }).backends;
export const CONFORMANCE: Conformance = {
  backends: Object.fromEntries(RACE_BACKENDS.map((id) => [id, { ...FACTS[id], ci: ciFigures[id] }])) as Record<BackendId, BackendConformance>,
};
