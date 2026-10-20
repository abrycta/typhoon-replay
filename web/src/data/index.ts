// Public surface of the static data layer. Features import from here, never from deeper files.
// This module must never import src/api (lint rule): the replay works with every backend asleep.
export { CATALOG_SORTS, decades, DEFAULT_SORT, filterStorms, seasons, sortStorms, type CatalogFilter, type CatalogSort } from "./catalog";
export { DataError, framesUrl, loadManifest, ogImageUrl, resolveDataset, type ResolvedDataset } from "./dataset";
export { FrameStore, type FrameStoreSnapshot } from "./frames/store";
export { decoder, frameBounds, maxNear, UV_SCALE, type TyfHeader, type TyfVar } from "./frames/tyf";
export { useDataset, useFrameStore, useManifest, useStormDetail, useStormIndex, useStormTrack } from "./hooks";
export { bestWind, hourAt, interpolateHourly } from "./track";
