// The baked basemap (scripts/build-embed.mjs): two images per theme placed by their corner coordinates, the
// land and sea under the field and the place labels above it, as in the live app. Only the active theme's
// images are fetched; a theme change swaps them in place.
import type { ImageSource, Map as MlMap, StyleSpecification } from "maplibre-gl";

import type { CustomBasemap, ThemeKey } from "@/features/replay";

import { EMBED } from "./haiyan.generated";

const images = (key: ThemeKey) => (key.startsWith("dark") ? EMBED.basemap.dark : EMBED.basemap.light);
const coordinates = EMBED.basemap.coordinates.map(([lon, lat]) => [lon, lat]) as [[number, number], [number, number], [number, number], [number, number]];

export const bakedBasemap: CustomBasemap = {
  style(key): StyleSpecification {
    const img = images(key);
    return {
      version: 8,
      sources: {
        "embed-base": { type: "image", url: img.base, coordinates },
        "embed-labels": { type: "image", url: img.labels, coordinates },
        // No features: it only carries the basemap's credit into the attribution control.
        "embed-credit": { type: "geojson", data: { type: "FeatureCollection", features: [] }, attribution: EMBED.basemap.attribution },
      },
      layers: [
        { id: "embed-base", type: "raster", source: "embed-base", paint: { "raster-fade-duration": 0 } },
        { id: "embed-credit", type: "circle", source: "embed-credit" },
        { id: "embed-labels", type: "raster", source: "embed-labels", metadata: { "replay:above-field": true }, paint: { "raster-fade-duration": 0 } },
      ],
    };
  },
  theme(map: MlMap, key) {
    const img = images(key);
    for (const [id, url] of [["embed-base", img.base], ["embed-labels", img.labels]] as const) {
      const src = map.getSource(id) as ImageSource | undefined;
      if (src && src.url !== url) src.updateImage({ url });
    }
  },
};
