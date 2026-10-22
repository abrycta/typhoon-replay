// The one packed data file (scripts/build-embed.mjs): storm summary, track and the lossless .tyf frame of every moment.
import { FrameStore, getJson, parseHeader, windToUv } from "@/data";
import type { StormDetail, StormTrack, TrackFix, TrackHour } from "@/shared/model/types";

import { EMBED } from "./haiyan.generated";

interface Pack {
  sid: string;
  detail: StormDetail;
  track: { fixes: TrackFix[]; hours: TrackHour[] };
  tyf: { header: string; frames: { index: number; data: string }[] };
}

export interface EmbedData {
  detail: StormDetail;
  track: StormTrack;
  store: FrameStore;
}

const bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

export async function loadPack(url: string = EMBED.pack): Promise<EmbedData> {
  // Same request as the <link rel=preload> in the embed's HTML (cors mode, same credentials).
  const p = await getJson<Pack>(url);
  const parsed = parseHeader(bytes(p.tyf.header));
  if (!parsed) throw new Error("embed pack: incomplete frame header");
  const { header } = parsed;
  const store = FrameStore.fromFrames(
    header,
    p.tyf.frames.map((f) => {
      const raw = bytes(f.data);
      return { start: f.index, raw, uv: windToUv(raw, header), count: 1 };
    }),
  );
  const d = p.detail;
  const detail: StormDetail = {
    ...d,
    landfallCountries: d.landfallCountries ?? [],
    intensity: d.intensity ?? [],
    landfalls: d.landfalls ?? [],
    sources: d.sources ?? [],
    replayAvailable: d.replayAvailable ?? Boolean(d.frames),
  };
  return { detail, track: { sid: p.sid, fixes: p.track.fixes, hours: p.track.hours }, store };
}
