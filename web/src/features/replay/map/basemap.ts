import { applyBasemapTheme, coastlineLayer } from "@abrycta/akari/maps";
import { flat } from "@abrycta/akari/tokens";
import type { LayerSpecification, Map as MlMap, StyleSpecification } from "maplibre-gl";

/** Keyless vector basemap (OpenFreeMap, OpenMapTiles schema), recoloured with Akari's map tokens. */
export const BASEMAP_STYLE = "https://tiles.openfreemap.org/styles/positron";

export type ThemeKey = "light" | "dark" | "light-hc" | "dark-hc";

/**
 * A basemap in place of OpenFreeMap (the frozen embed's baked images): its style for a theme, and how to re-theme
 * it in place. Layers with `metadata: { "replay:above-field": true }` are drawn above the field, like symbols.
 */
export interface CustomBasemap {
  style(key: ThemeKey): StyleSpecification;
  theme(map: MlMap, key: ThemeKey): void;
}

export function themeKey(theme: "light" | "dark", hc: boolean): ThemeKey {
  return hc ? `${theme}-hc` : theme;
}

export function tokenColor(id: string, key: ThemeKey): string {
  const t = (flat as unknown as Record<string, Record<string, string>>)[id];
  return t?.[key] ?? t?.light ?? "#888";
}

/** Offline fallback: Natural Earth 50 m coastline only (bundled, public domain). */
export function fallbackStyle(key: ThemeKey): StyleSpecification {
  return {
    version: 8,
    sources: { coast: { type: "geojson", data: "/basemap/coast.geojson", attribution: "Natural Earth" } },
    layers: [
      { id: "background", type: "background", paint: { "background-color": tokenColor("map.background", key) } },
      { id: "coastline", type: "line", source: "coast", paint: { "line-color": tokenColor("map.coast", key), "line-width": 0.8 } },
    ],
  };
}

export function themeBasemap(map: MlMap, key: ThemeKey, usingFallback: boolean) {
  if (usingFallback) {
    if (map.getLayer("background")) map.setPaintProperty("background", "background-color", tokenColor("map.background", key));
    if (map.getLayer("coastline")) map.setPaintProperty("coastline", "line-color", tokenColor("map.coast", key));
    return;
  }
  applyBasemapTheme(map, key);
  // A coastline on the water polygons' edges (OpenMapTiles "water"), above the water fill: land and sea separate in every theme.
  const coast = coastlineLayer({ id: "akari-coastline", source: "openmaptiles", theme: key });
  if (!map.getSource("openmaptiles")) return;
  if (!map.getLayer(coast.id)) {
    const layers = map.getStyle().layers ?? [];
    const lastWater = layers.map((l) => l.id).lastIndexOf("water");
    const before = lastWater >= 0 ? layers[lastWater + 1]?.id : undefined;
    map.addLayer(coast as unknown as LayerSpecification, before);
  } else map.setPaintProperty(coast.id, "line-color", coast.paint["line-color"]);
}
