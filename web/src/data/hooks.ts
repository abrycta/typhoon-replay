import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, useSyncExternalStore } from "react";

import { useAppConfig } from "@/shared/config/context";
import type { StormDetail } from "@/shared/model/types";

import { framesUrl, loadIndex, loadManifest, loadStormDetail, loadTrack, resolveDataset, type ResolvedDataset } from "./dataset";
import { FrameStore } from "./frames/store";
import { preparePlaces } from "./place-search";
import { loadPlaceIndex, loadPlaceShard } from "./places";

const STATIC = { staleTime: Infinity, gcTime: 30 * 60_000, retry: 1 } as const;

export function useDataset() {
  const cfg = useAppConfig();
  return useQuery({ queryKey: ["dataset", cfg.data.baseUrl], queryFn: () => resolveDataset(cfg.data), ...STATIC });
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

/** One place shard (its places and their storm exposure). */
export function usePlaceShard(url: string | undefined) {
  return useQuery({ queryKey: ["place-shard", url], queryFn: () => loadPlaceShard(url as string), enabled: !!url, ...STATIC });
}

/** Opens the storm's frames in a worker for as long as the component is mounted. */
export function useFrameStore(dataset: ResolvedDataset | undefined, detail: StormDetail | undefined, focus = 0) {
  const url = dataset && detail ? framesUrl(dataset, detail) : undefined;
  const format = detail?.frames?.format ?? "tyf";
  const [store, setStore] = useState<FrameStore | undefined>();
  useEffect(() => {
    if (!url) return;
    const s = FrameStore.open(url, format, focus);
    // The store wraps an external system (a worker); publishing it to render is the point of this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStore(s);
    return () => {
      s.dispose();
      setStore(undefined);
    };
    // focus only seeds the first window; later moves go through store.prioritise()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, format]);
  const snap = useSyncExternalStore(store?.subscribe ?? noopSubscribe, store?.getSnapshot ?? emptySnapshot);
  return { store, snap };
}

const noopSubscribe = () => () => {};
const EMPTY = { loadedFrames: 0, loadedBytes: 0, done: false } as const;
const emptySnapshot = () => EMPTY;
