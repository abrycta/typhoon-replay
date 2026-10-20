// Typed URL state shared by routes (files starting with "-" are not routes). zod/mini keeps the
// validators out of the initial bundle's budget (~40 kB smaller than classic zod).
import { z } from "zod/mini";

export const replayDefaults = { layer: "wind", speed: 4, track: true, units: "ms", tz: "local" } as const;

const opt = <T extends z.ZodMiniType>(s: T) => z.catch(z.optional(s), undefined);
const layer = z.catch(z._default(z.enum(["wind", "gust", "rain", "pressure", "none"]), "wind"), "wind");
const units = z.catch(z._default(z.enum(["ms", "kt"]), "ms"), "ms");
const speed = z.catch(z._default(z.pipe(z.coerce.number(), z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8), z.literal(16)])), 4), 4);

export const replaySearch = z.object({
  t: opt(z.string().check(z.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/))),
  layer,
  speed,
  particles: opt(z.boolean()),
  track: z.catch(z._default(z.boolean(), true), true),
  units,
  tz: z.catch(z._default(z.enum(["local", "utc"]), "local"), "local"),
  v: opt(z.string().check(z.regex(/^-?[\d.]+,-?[\d.]+,[\d.]+$/))),
});
export type ReplaySearch = z.infer<typeof replaySearch>;

export const catalogSearch = z.object({
  q: opt(z.string()),
  decade: opt(z.pipe(z.coerce.number(), z.int())),
  season: opt(z.pipe(z.coerce.number(), z.int())),
  country: opt(z.enum(["PH", "JP"])),
});

export const compareSearch = z.object({
  a: opt(z.string()),
  b: opt(z.string()),
  h: opt(z.pipe(z.coerce.number(), z.int().check(z.minimum(0)))),
  layer,
  units,
});

export const townSearch = z.object({
  q: opt(z.string()),
  place: opt(z.string()),
  radius: z.catch(z._default(z.pipe(z.coerce.number(), z.union([z.literal(50), z.literal(100), z.literal(200), z.literal(300), z.literal(500)])), 100), 100),
});
