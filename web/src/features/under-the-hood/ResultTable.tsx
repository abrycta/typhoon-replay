import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, useLang } from "@abrycta/akari/react";
import { useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";

import { stormTitle } from "@/shared/lib/names";
import { formatDate } from "@/shared/lib/time";
import type { LocalNames } from "@/shared/model/types";

import type { QuestionId } from "./catalogue";

// Tolerant readers: the body is whatever a backend sent; a missing field shows as "–".
type O = Record<string, unknown>;
const obj = (x: unknown): O => (x && typeof x === "object" && !Array.isArray(x) ? (x as O) : {});
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const num = (x: unknown): number | undefined => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
const str = (x: unknown): string | undefined => (typeof x === "string" ? x : undefined);
const dash = "–";

const SHOW = 10;

function Grid({ head, rows, numeric = [] }: { head: string[]; rows: ReactNode[][]; numeric?: number[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {head.map((h, i) => (
            <TableHead key={h} className={numeric.includes(i) ? "text-right" : undefined}>
              {h}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r, i) => (
          <TableRow key={i}>
            {r.map((c, j) => (
              <TableCell key={j} className={numeric.includes(j) ? "text-right font-mono tabular-nums" : undefined}>
                {c}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** The answer to a race question, as a table. Returns the table and a caption fragment ("10 of 23 shown"). */
export function ResultTable({ question, body }: { question: QuestionId; body: unknown }) {
  const { t } = useLingui();
  const { lang } = useLang();
  const b = obj(body);

  if (question === "town") {
    const items = arr(b.items);
    const rows = items.slice(0, SHOW).map((x) => {
      const h = obj(x);
      const s = obj(h.storm);
      const title = stormTitle({ name: str(s.name) ?? dash, localNames: obj(s.localNames) as LocalNames }, lang);
      return [title, num(s.season) ?? dash, num(h.closestApproachKm)?.toFixed(0) ?? dash, num(h.maxWindKtWithinRadius)?.toFixed(0) ?? dash, num(h.hoursWithinRadius) ?? dash];
    });
    return (
      <>
        <Grid head={[t`Storm`, t`Season`, t`Closest (km)`, t`Max wind (kt)`, t`Hours within 100 km`]} rows={rows} numeric={[1, 2, 3, 4]} />
        <p className="mt-2 text-xs text-muted-foreground">{items.length > SHOW ? t`${SHOW} of ${items.length} storms shown.` : t`${items.length} storms.`}</p>
      </>
    );
  }

  if (question === "storm") {
    const peak = obj(b.peak);
    const landfalls = arr(b.landfalls).map(obj);
    const rows: ReactNode[][] = [
      [t`Name`, stormTitle({ name: str(b.name) ?? dash, localNames: obj(b.localNames) as LocalNames }, lang)],
      [t`Season`, num(b.season) ?? dash],
      [t`Peak wind`, num(peak.windKt) !== undefined ? `${num(peak.windKt)} kt (${(str(peak.agency) ?? "").toUpperCase()})` : dash],
      [t`Lowest pressure`, num(peak.pressureHpa) !== undefined ? `${num(peak.pressureHpa)} hPa` : dash],
      [t`Landfalls`, landfalls.length ? landfalls.map((l) => `${str(l.country) ?? "?"} ${str(l.at) ? formatDate(str(l.at) as string, lang) : ""}`.trim()).join(" · ") : dash],
      [t`Duration`, num(b.durationHours) !== undefined ? `${num(b.durationHours)} h` : dash],
    ];
    return <Grid head={[t`Field`, t`Value`]} rows={rows} />;
  }

  const items = arr(b.items).map(obj);
  const rows = items.slice(0, SHOW).map((p) => {
    const name = lang === "ja" && str(p.nameJa) ? str(p.nameJa) : str(p.name);
    const region = lang === "ja" && str(p.admin1Ja) ? str(p.admin1Ja) : [str(p.admin2), str(p.admin1)].filter(Boolean).join(", ");
    return [name ?? dash, region || dash, str(p.country) ?? dash, str(p.kind) ?? dash];
  });
  return <Grid head={[t`Place`, t`Region`, t`Country`, t`Type`]} rows={rows} />;
}
