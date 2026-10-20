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
  passed: number;
  total: number;
}

export interface BackendConformance {
  stack: string;
  status: "measured" | "next";
  scenarios?: PassCount;
  generated?: PassCount;
  p95StormsListMs?: number;
  coldStartS?: number;
}

export interface Conformance {
  source: string;
  updatedAt: string;
  backends: Record<BackendId, BackendConformance>;
}

/** conformance.json, checked into the build (it is imported, so Vite inlines it at build time). */
export const CONFORMANCE: Conformance = conformanceJson as Conformance;
