import { useLang } from "@abrycta/akari/react";
import { useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";

import { landfallSummary } from "@/shared/lib/landfalls";
import { stormLabel } from "@/shared/lib/names";
import { formatDate } from "@/shared/lib/time";
import { ktToMs } from "@/shared/lib/units";
import type { StormDetail } from "@/shared/model/types";
import { StormName } from "@/shared/ui/storm-name";

/** The storm page's title block (eyebrow, name, Japanese name, dates/peak/landfalls lede) with its actions below. */
export function StormHeading({ s, children }: { s: StormDetail; children?: ReactNode }) {
  const { t } = useLingui();
  const { lang } = useLang();
  const jtwc = s.intensity.find((i) => i.agency === "jtwc");
  const jma = s.intensity.find((i) => i.agency === "jma");
  const peak = [
    jtwc?.maxWindKt !== undefined ? t`${jtwc.maxWindKt.toFixed(0)} kt (${ktToMs(jtwc.maxWindKt).toFixed(0)} m/s) JTWC 1-min` : undefined,
    jma?.maxWindKt !== undefined ? t`${jma.maxWindKt.toFixed(0)} kt JMA 10-min` : undefined,
    jma?.minPressureHpa !== undefined ? `${jma.minPressureHpa.toFixed(0)} hPa` : undefined,
  ].filter(Boolean);

  return (
    <header className="-mt-4 grid gap-2">
      <p className="font-mono text-xs tracking-[0.08em] text-muted-foreground uppercase">
        Replay · {s.season} · {s.sid}
      </p>
      <h1 className="font-heading text-ak-title font-semibold">
        <StormName s={s} />
      </h1>
      {s.localNames?.ja && stormLabel(s).kind !== "jma" ? (
        <p lang="ja" className="text-muted-foreground">
          {s.localNames.ja}
        </p>
      ) : null}
      <p className="max-w-[68ch] text-muted-foreground" data-testid="storm-lede">
        {formatDate(s.startedAt, lang)} – {formatDate(s.endedAt, lang)}
        {peak.length ? ` · ${t`peak`} ${peak.join(" · ")}` : ""}
        {s.landfalls.length
          ? ` · ${landfallSummary(s.landfalls, lang, {
              lead: (g, dates) =>
                g.count > 1
                  ? g.country === "PH"
                    ? t`landfalls in the Philippines ${dates} (${g.count})`
                    : t`landfalls in Japan ${dates} (${g.count})`
                  : g.country === "PH"
                    ? t`landfall in the Philippines ${dates}`
                    : t`landfall in Japan ${dates}`,
              more: (g, dates) =>
                (g.country === "PH" ? t`Philippines ${dates}` : t`Japan ${dates}`) + (g.count > 1 ? ` (${g.count})` : ""),
            })}`
          : ""}
      </p>
      {children}
    </header>
  );
}
