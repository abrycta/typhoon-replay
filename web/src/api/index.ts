// Public surface of the API layer. Features import from "@/api" only; nothing outside src/api may
// import openapi-fetch, msw or src/api/generated (lint rule).
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";

import type { BackendId } from "@/shared/config/config";

import { displayHealth, probeBackend, useBackends } from "./backends";
import { metaQuery, placeSearchQuery, placeStormsQuery, type RadiusKm, stormPlacesQuery } from "./queries";

export { ApiError } from "./client";
export {
  displayHealth,
  initBackends,
  probeBackend,
  selectBackend,
  useBackends,
  type BackendHealth,
  type HealthState,
} from "./backends";
export { useLastResponse, type ResponseInfo } from "./info";
export type { RadiusKm } from "./queries";

/** The selected backend, probed once when a feature that needs the API mounts. */
export function useApiBackend(): { id: BackendId; state: ReturnType<typeof displayHealth> } {
  const { selected, health } = useBackends();
  const h = health[selected];
  const state = displayHealth(h);
  useEffect(() => {
    if (state === "asleep" || state === "unknown") void probeBackend(selected);
  }, [selected, state]);
  return { id: selected, state };
}

export function usePlaceSearch(q: string) {
  const { id } = useApiBackend();
  return useQuery(placeSearchQuery(id, q));
}

export function usePlaceStorms(placeId: string | undefined, radiusKm: RadiusKm) {
  const { id } = useApiBackend();
  return useQuery({ ...placeStormsQuery(id, placeId ?? "", radiusKm), enabled: !!placeId });
}

export function useStormPlaces(sid: string, opts: { enabled: boolean; radiusKm?: RadiusKm }) {
  const { id } = useApiBackend();
  return useQuery({ ...stormPlacesQuery(id, sid, opts.radiusKm), enabled: opts.enabled });
}

export function useMeta(enabled: boolean) {
  const { selected } = useBackends();
  return useQuery({ ...metaQuery(selected), enabled });
}
