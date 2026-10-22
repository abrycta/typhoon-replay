import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { useAppConfig } from "@/shared/config/context";
import type { StormDetail } from "@/shared/model/types";

import {
  bakedDataset,
  loadIndex,
  loadManifest,
  loadStormDetail,
  loadTrack,
  remoteStormRoot,
  resolveDataset,
  type ResolvedDataset,
  sameDataset,
  stormRoot,
} from "./dataset";
import { frameSource, sourceKey } from "./frames/source";
import { FrameStore } from "./frames/store";
import { type PreparedPlace, preparePlaces, queryShardKey, searchPlaces } from "./place-search";
import { loadPlaceIndex, loadPlaceShard, loadPlaceSlice, loadSliceManifest, type PlaceEntry } from "./places";

const STATIC = { staleTime: Infinity, gcTime: 30 * 60_000, retry: 1 } as const;

/**
 * The dataset version to read. A build that bundled data knows its version already: that one is used at once (no
 * pointer round trip before the first request), the pointer is read in the background, and a newer version, or the
 * fallback host when the primary is down, replaces it.
 */
export function useDataset() {
  const cfg = useAppConfig();
  const qc = useQueryClient();
  const queryKey = ["dataset", cfg.data.baseUrl];
  return useQuery({
    queryKey,
    queryFn: () => {
      const baked = bakedDataset(cfg.data);
      if (!baked) return resolveDataset(cfg.data);
      resolveDataset(cfg.data).then(
        (live) => {
          if (!sameDataset(baked, live)) qc.setQueryData(queryKey, live);
        },
        // Nothing reachable: the bundled storms still play; everything else reports its own error.
        () => {},
      );
      return baked;
    },
    ...STATIC,
  });
}

export function useManifest() {
  const ds = useDataset();
  const q = useQuery({ queryKey: ["manifest", ds.data?.root], queryFn: () => loadManifest(ds.data as ResolvedDataset), enabled: !!ds.data, ...STATIC });
  return { ...q, dataset: ds.data, error: ds.error ?? q.error };
}

export function useStormIndex() {
  const ds = useDataset();
  const q = useQuery({
    queryKey: ["index", ds.data?.root],
    queryFn: () => loadIndex(ds.data as ResolvedDataset),
    enabled: !!ds.data,
    ...STATIC,
  });
  return { ...q, error: ds.error ?? q.error, isPending: ds.isPending || q.isPending, dataset: ds.data };
}

export function useStormDetail(sid: string | undefined) {
  const ds = useDataset();
  const q = useQuery({
    queryKey: ["storm", ds.data?.root, sid],
    queryFn: () => loadStormDetail(ds.data as ResolvedDataset, sid as string),
    enabled: !!ds.data && !!sid,
    ...STATIC,
  });
  return { ...q, error: ds.error ?? q.error, isPending: ds.isPending || q.isPending, dataset: ds.data };
}

export function useStormTrack(sid: string | undefined) {
  const ds = useDataset();
  return useQuery({
    queryKey: ["track", ds.data?.root, sid],
    queryFn: () => loadTrack(ds.data as ResolvedDataset, sid as string),
    enabled: !!ds.data && !!sid,
    ...STATIC,
  });
}

/** The static place search index, prepared for searching. Load it only where place search is used. */
export function usePlaceIndex(enabled = true) {
  const ds = useDataset();
  const q = useQuery({
    queryKey: ["places", ds.data?.root],
    queryFn: async () => preparePlaces(await loadPlaceIndex(ds.data as ResolvedDataset)),
    enabled: enabled && !!ds.data,
    ...STATIC,
  });
  return { ...q, error: ds.error ?? q.error, isPending: ds.isPending || q.isPending };
}

/**
 * Place search for "my town": reads only the slice of the index the query's first letters need (a few kB), and
 * falls back to the full index when the dataset has no slices, a slice fails, the slice finds nothing (the full
 * search also matches inside words and forgives a typo in the first letter) or the selected place is elsewhere.
 */
export function usePlaceSearch(q: string, placeId?: string, limit = 10) {
  const ds = useDataset();
  const active = q.length >= 2;
  const manifest = useQuery({
    queryKey: ["place-slices", ds.data?.root],
    queryFn: () => loadSliceManifest(ds.data as ResolvedDataset),
    enabled: !!ds.data && (active || !!placeId),
    ...STATIC,
  });
  const key = active && manifest.data ? queryShardKey(q, manifest.data) : undefined;
  const slice = useQuery({
    queryKey: ["place-slice", ds.data?.root, key],
    queryFn: async () => preparePlaces(await loadPlaceSlice(ds.data as ResolvedDataset, key as string)),
    enabled: !!ds.data && !!key,
    ...STATIC,
  });
  const sliceHits = useMemo(() => (active && slice.data ? searchPlaces(slice.data, q, limit) : undefined), [active, slice.data, q, limit]);
  const sliceSelected = placeId ? slice.data?.find((e) => e.place.id === placeId)?.place : undefined;
  const manifestDone = manifest.isSuccess || manifest.isError;
  const sliceDone = !key || slice.isSuccess || slice.isError;
  const needFull =
    manifestDone && sliceDone && ((active && (!key || slice.isError || sliceHits?.length === 0)) || (!!placeId && !sliceSelected));
  const full = usePlaceIndex(needFull);
  const fullHits = useMemo(() => (needFull && active && full.data ? searchPlaces(full.data, q, limit) : undefined), [needFull, active, full.data, q, limit]);
  const results: PlaceEntry[] = (needFull ? fullHits : sliceHits) ?? [];
  const selected = sliceSelected ?? (placeId ? full.data?.find((e: PreparedPlace) => e.place.id === placeId)?.place : undefined);
  const isPending = ds.isPending || (!manifestDone && (active || !!placeId)) || (!!key && slice.isPending) || (needFull && full.isPending);
  return { results, selected, isPending, error: needFull ? full.error : (ds.error ?? null) };
}

/** One place shard (its places and their storm exposure). */
export function usePlaceShard(url: string | undefined) {
  return useQuery({ queryKey: ["place-shard", url], queryFn: () => loadPlaceShard(url as string), enabled: !!url, ...STATIC });
}

/**
 * Opens the storm's frames (WebP preferred, else .tyf) in a worker for as long as the component is mounted.
 * A `preset` store (the frozen embed's packed frame) is used as it is: no worker, no requests.
 */
export function useFrameStore(
  dataset: ResolvedDataset | undefined,
  detail: StormDetail | undefined,
  focus = 0,
  preset?: FrameStore,
  /** The layer on show when the store opens: it loads before the others. */
  first?: string,
) {
  const source = useMemo(
    () =>
      !preset && dataset && detail
        ? frameSource(detail.sid, detail.frames, stormRoot(dataset, detail.sid), remoteStormRoot(dataset, detail.sid))
        : undefined,
    [dataset, detail, preset],
  );
  const key = sourceKey(source);
  const [store, setStore] = useState<FrameStore | undefined>();
  useEffect(() => {
    if (!source) return;
    const s = FrameStore.open(source, focus, first);
    // The store wraps an external system (a worker); publishing it to render is the point of this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStore(s);
    return () => {
      s.dispose();
      setStore(undefined);
    };
    // Reopen only when the files change (key); focus only seeds the first window, later moves go through
    // store.prioritise(), and first only orders the first load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const active = preset ?? store;
  const snap = useSyncExternalStore(active?.subscribe ?? noopSubscribe, active?.getSnapshot ?? emptySnapshot);
  return { store: active, snap };
}

const noopSubscribe = () => () => {};
const EMPTY = { loadedFrames: 0, loadedBytes: 0, done: false } as const;
const emptySnapshot = () => EMPTY;
