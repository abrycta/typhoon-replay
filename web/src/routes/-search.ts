// Typed URL state shared by routes (files starting with "-" are not routes).
import { z } from "zod";

export const replayDefaults = { layer: "wind", speed: 4, track: true, units: "ms", tz: "local" } as const;

export const replaySearch = z.object({
  t: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/).optional().catch(undefined),
  layer: z.enum(["wind", "gust", "rain", "pressure", "none"]).default(replayDefaults.layer).catch(replayDefaults.layer),
  speed: z.coerce.number().pipe(z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8), z.literal(16)])).default(4).catch(4),
  particles: z.boolean().optional().catch(undefined),
  track: z.boolean().default(true).catch(true),
  units: z.enum(["ms", "kt"]).default("ms").catch("ms"),
  tz: z.enum(["local", "utc"]).default("local").catch("local"),
  v: z.string().regex(/^-?[\d.]+,-?[\d.]+,[\d.]+$/).optional().catch(undefined),
});
export type ReplaySearch = z.infer<typeof replaySearch>;

export const catalogSearch = z.object({
  q: z.string().optional().catch(undefined),
  decade: z.coerce.number().int().optional().catch(undefined),
  season: z.coerce.number().int().optional().catch(undefined),
  country: z.enum(["PH", "JP"]).optional().catch(undefined),
});

export const compareSearch = z.object({
  a: z.string().optional().catch(undefined),
  b: z.string().optional().catch(undefined),
  h: z.coerce.number().int().min(0).optional().catch(undefined),
  layer: replaySearch.shape.layer,
  units: replaySearch.shape.units,
});

export const townSearch = z.object({
  q: z.string().optional().catch(undefined),
  place: z.string().optional().catch(undefined),
  radius: z.coerce.number().pipe(z.union([z.literal(50), z.literal(100), z.literal(200), z.literal(300), z.literal(500)])).default(100).catch(100),
});
