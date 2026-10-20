// DTO -> domain mappers. The contract's shapes already match the domain closely; the adapter is the
// one place that would absorb a contract change, and it drops fields features do not use.
import type { PlaceHit, PlaceSummary, StormHit, StormSummary } from "@/shared/model/types";

import type { components } from "./generated/schema";

type S = components["schemas"];

export function toPlace(p: S["PlaceSummary"]): PlaceSummary {
  return {
    id: p.id,
    country: p.country,
    kind: p.kind,
    name: p.name,
    nameJa: p.nameJa,
    admin1: p.admin1,
    admin1Ja: p.admin1Ja,
    admin2: p.admin2,
    centroid: [p.centroid[0] ?? 0, p.centroid[1] ?? 0],
  };
}

export function toStorm(s: S["StormSummary"]): StormSummary {
  return {
    sid: s.sid,
    name: s.name,
    localNames: s.localNames,
    season: s.season,
    basin: s.basin,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    peakWindKt: s.peakWindKt,
    peakWindAgency: s.peakWindAgency,
    minPressureHpa: s.minPressureHpa,
    landfallCountries: s.landfallCountries,
  };
}

export function toStormHit(h: S["StormHit"]): StormHit {
  return {
    storm: toStorm(h.storm),
    closestApproachKm: h.closestApproachKm,
    closestApproachAt: h.closestApproachAt,
    maxWindKtWithinRadius: h.maxWindKtWithinRadius,
    maxGustKtWithinRadius: h.maxGustKtWithinRadius,
    hoursWithinRadius: h.hoursWithinRadius,
  };
}

export function toPlaceHit(h: S["PlaceHit"]): PlaceHit {
  return {
    place: toPlace(h.place),
    closestApproachKm: h.closestApproachKm,
    closestApproachAt: h.closestApproachAt,
    maxWindKtWithinRadius: h.maxWindKtWithinRadius,
    maxGustKtWithinRadius: h.maxGustKtWithinRadius,
    hoursWithinRadius: h.hoursWithinRadius,
  };
}
