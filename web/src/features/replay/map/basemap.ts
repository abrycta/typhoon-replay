import { applyBasemapTheme } from "@abrycta/akari/maps";
import { flat } from "@abrycta/akari/tokens";
import type { Map as MlMap, StyleSpecification } from "maplibre-gl";

/** Keyless vector basemap (OpenFreeMap, OpenMapTiles schema), recoloured with Akari's map tokens. */
export const BASEMAP_STYLE = "https://tiles.openfreemap.org/styles/positron";

export type ThemeKey = "light" | "dark" | "light-hc" | "dark-hc";

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
      { id: "background", type: "background", paint: { "background-color": tokenColor("color.bg", key) } },
      { id: "coastline", type: "line", source: "coast", paint: { "line-color": tokenColor("color.text-muted", key), "line-width": 0.8 } },
    ],
  };
}

export function themeBasemap(map: MlMap, key: ThemeKey, usingFallback: boolean) {
  if (usingFallback) {
    if (map.getLayer("background")) map.setPaintProperty("background", "background-color", tokenColor("color.bg", key));
    if (map.getLayer("coastline")) map.setPaintProperty("coastline", "line-color", tokenColor("color.text-muted", key));
    return;
  }
  applyBasemapTheme(map, key.startsWith("dark") ? "dark" : "light");
}
