import { Label, NativeSelect, NativeSelectOption, Skeleton, useLang } from "@abrycta/akari/react";
import { useLingui } from "@lingui/react/macro";
import { type ReactNode, useCallback, useState } from "react";

import { type ResolvedDataset, useStormDetail, useStormIndex } from "@/data";
import type { FieldLayer } from "@/shared/lib/fields";
import { stormTitle } from "@/shared/lib/names";
import type { SpeedUnit } from "@/shared/lib/units";
import type { StormDetail } from "@/shared/model/types";

/** The route supplies the replay (features never import each other). */
export type RenderReplay = (p: { detail: StormDetail; dataset: ResolvedDataset; layer: FieldLayer | "none"; units: SpeedUnit; syncIndex: number; onIndex: (i: number) => void }) => ReactNode;

export interface CompareUrl {
  a?: string;
  b?: string;
  /** Hours since each storm's first frame (kept in step). */
  h?: number;
  layer: FieldLayer | "none";
  units: SpeedUnit;
}

function Picker({ id, label, value, onChange }: { id: string; label: string; value?: string; onChange: (sid: string) => void }) {
  const { t } = useLingui();
  const { lang } = useLang();
  const index = useStormIndex();
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <NativeSelect id={id} value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
        <NativeSelectOption value="">{t`Choose a storm`}</NativeSelectOption>
        {(index.data ?? []).map((s) => (
          <NativeSelectOption key={s.sid} value={s.sid}>
            {stormTitle(s, lang)} {s.season}
            {s.replayAvailable ? "" : ` (${t`track only`})`}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </div>
  );
}

function Side({ sid, url, index, onIndex, label, render }: { sid?: string; url: CompareUrl; index: number; onIndex: (i: number) => void; label: string; render: RenderReplay }) {
  const { t } = useLingui();
  const { lang } = useLang();
  const d = useStormDetail(sid);
  if (!sid) return <div className="grid aspect-[4/3] place-items-center rounded-sm border border-dashed border-border text-sm text-muted-foreground">{t`Pick a storm`}</div>;
  if (d.error) return <p className="text-sm text-destructive">{t`Could not load ${sid}.`}</p>;
  if (!d.data || !d.dataset) return <Skeleton className="aspect-[4/3]" />;
  return (
    <section aria-label={label} className="grid gap-2">
      <h2 className="font-heading text-xl font-semibold">
        {stormTitle(d.data, lang)} <span className="font-mono text-base text-muted-foreground">{d.data.season}</span>
      </h2>
      {render({ detail: d.data, dataset: d.dataset, layer: url.layer, units: url.units, syncIndex: index, onIndex })}
    </section>
  );
}

/** Two storms side by side, scrubbed together by hours since each storm's first frame. */
export function CompareView({ url, onUrl, renderReplay }: { url: CompareUrl; onUrl: (p: Partial<CompareUrl>) => void; renderReplay: RenderReplay }) {
  const { t } = useLingui();
  const [index, setIndex] = useState(url.h ?? 0);
  const onIndex = useCallback(
    (i: number) => {
      setIndex(i);
      if (i !== url.h) onUrl({ h: i });
    },
    [onUrl, url.h],
  );
  return (
    <div className="grid gap-6">
      <div className="grid gap-3 sm:grid-cols-2">
        <Picker id="cmp-a" label={t`First storm`} value={url.a} onChange={(a) => onUrl({ a: a || undefined })} />
        <Picker id="cmp-b" label={t`Second storm`} value={url.b} onChange={(b) => onUrl({ b: b || undefined })} />
      </div>
      <p className="text-sm text-muted-foreground">{t`Both replays move together: the scrubbers count hours from each storm's first frame. Colours use the same fixed scale for every storm.`}</p>
      <div className="grid gap-6 lg:grid-cols-2">
        <Side sid={url.a} url={url} index={index} onIndex={onIndex} label={t`First storm`} render={renderReplay} />
        <Side sid={url.b} url={url} index={index} onIndex={onIndex} label={t`Second storm`} render={renderReplay} />
      </div>
    </div>
  );
}
