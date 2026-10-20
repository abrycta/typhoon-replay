// TanStack Query option factories. Keys always include the backend id, so switching backend never
// shows one backend's cached answer as another's.
import { queryOptions } from "@tanstack/react-query";

import type { BackendId } from "@/shared/config/config";
import type { PlaceHit, PlaceSummary, StormHit } from "@/shared/model/types";

import { toPlace, toPlaceHit, toStormHit } from "./adapters";
import { baseUrlOf, ensureMock, noteSuccess } from "./backends";
import { ApiError, apiClient, unwrap } from "./client";

export type RadiusKm = 50 | 100 | 200 | 300 | 500;

async function call<T>(backend: BackendId, run: (c: ReturnType<typeof apiClient>) => Promise<{ data?: T; error?: unknown; response: Response }>) {
  if (backend === "mock") await ensureMock();
  const data = await unwrap(run(apiClient(baseUrlOf(backend))), backend);
  noteSuccess(backend);
  return data;
}

const retry = (count: number, e: unknown) => count < 2 && e instanceof ApiError && e.retriable;
const retryDelay = (n: number) => Math.min(1000 * 2 ** n, 8000);

export const placeSearchQuery = (backend: BackendId, q: string) =>
  queryOptions({
    queryKey: ["api", backend, "places", "search", q],
    queryFn: async (): Promise<PlaceSummary[]> => {
      const r = await call(backend, (c) => c.GET("/v1/places/search", { params: { query: { q, limit: 10 } } }));
      return r.items.map(toPlace);
    },
    enabled: q.trim().length >= 2,
    staleTime: 5 * 60_000,
    retry,
    retryDelay,
  });

export const placeStormsQuery = (backend: BackendId, placeId: string, radiusKm: RadiusKm) =>
  queryOptions({
    queryKey: ["api", backend, "places", placeId, "storms", radiusKm],
    queryFn: async (): Promise<StormHit[]> => {
      const r = await call(backend, (c) =>
        c.GET("/v1/places/{placeId}/storms", { params: { path: { placeId }, query: { radiusKm, sort: "closest", limit: 50 } } }),
      );
      return r.items.map(toStormHit);
    },
    staleTime: 5 * 60_000,
    retry,
    retryDelay,
  });

export const stormPlacesQuery = (backend: BackendId, sid: string, radiusKm: RadiusKm = 200) =>
  queryOptions({
    queryKey: ["api", backend, "storms", sid, "places", radiusKm],
    queryFn: async (): Promise<PlaceHit[]> => {
      const r = await call(backend, (c) => c.GET("/v1/storms/{sid}/places", { params: { path: { sid }, query: { radiusKm, limit: 50 } } }));
      return r.items.map(toPlaceHit);
    },
    staleTime: 5 * 60_000,
    retry,
    retryDelay,
  });

export const metaQuery = (backend: BackendId) =>
  queryOptions({
    queryKey: ["api", backend, "meta"],
    queryFn: () => call(backend, (c) => c.GET("/v1/meta")),
    staleTime: 60_000,
    retry: false,
  });
