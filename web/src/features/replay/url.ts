import type { TimeZoneChoice } from "@/shared/lib/time";
import type { StormDetail } from "@/shared/model/types";

import type { MapView } from "./map/ReplayMap";

/** `v=lon,lat,zoom` in the URL. */
export function parseView(v: string | undefined): MapView | undefined {
  const [lon, lat, zoom] = (v ?? "").split(",").map(Number);
  return [lon, lat, zoom].every((x) => Number.isFinite(x)) ? { lon: lon!, lat: lat!, zoom: zoom! } : undefined;
}

/** Local time for a storm: Philippine time unless it only made landfall in Japan. */
export function localZone(detail: Pick<StormDetail, "landfallCountries">): TimeZoneChoice {
  return detail.landfallCountries.includes("PH") || !detail.landfallCountries.includes("JP") ? "Asia/Manila" : "Asia/Tokyo";
}
