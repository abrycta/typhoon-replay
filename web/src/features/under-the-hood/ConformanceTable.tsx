import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, useLang } from "@abrycta/akari/react";
import { useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";

import type { BackendId } from "@/shared/config/config";
import { formatDate } from "@/shared/lib/time";

import { type BackendConformance, CONFORMANCE, type PassCount, RACE_BACKENDS } from "./catalogue";

/** Contract conformance per backend, from conformance.json (bundled at build time). */
export function ConformanceTable({ labels }: { labels: Record<BackendId, string> }) {
  const { t } = useLingui();
  const { lang } = useLang();
  const nf = new Intl.NumberFormat(lang === "ja" ? "ja-JP" : "en-GB");
  const next = <span className="text-muted-foreground">{t`next`}</span>;
  const none = <span className="text-muted-foreground">—</span>;
  const pass = (p?: PassCount) => (p ? <span className={p.passed === p.total ? "text-success" : "text-destructive"}>{`${nf.format(p.passed)} / ${nf.format(p.total)}`}</span> : undefined);
  const rows: { label: string; cell: (b: BackendConformance) => ReactNode }[] = [
    { label: t`Scenario tests (paging, caching, errors, live stream)`, cell: (b) => pass(b.scenarios) ?? next },
    { label: t`Generated API cases (Schemathesis)`, cell: (b) => pass(b.generated) ?? next },
    { label: t`Cold start on free hosting`, cell: (b) => (b.coldStartS !== undefined ? `≈ ${b.coldStartS} s` : none) },
  ];
  const pending = RACE_BACKENDS.filter((id) => CONFORMANCE.backends[id]?.status !== "measured").map((id) => labels[id]);
  return (
    <section aria-labelledby="conf-h" className="grid gap-3">
      <p className="font-mono text-xs tracking-[0.08em] text-muted-foreground uppercase">{t`Conformance`}</p>
      <h2 id="conf-h" className="font-heading text-ak-subsection font-semibold text-balance">
        {t`Does each backend keep the contract?`}
      </h2>
      <div className="min-w-0 overflow-x-auto rounded-sm border border-border bg-card p-4" data-testid="conformance">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t`Check`}</TableHead>
              {RACE_BACKENDS.map((id) => (
                <TableHead key={id}>{labels[id]}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.label}>
                <TableCell className="min-w-48 whitespace-normal">{r.label}</TableCell>
                {RACE_BACKENDS.map((id) => (
                  <TableCell key={id} className="font-mono tabular-nums">
                    {CONFORMANCE.backends[id] ? r.cell(CONFORMANCE.backends[id]) : next}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <p className="mt-2 text-xs text-muted-foreground">
          {t`From the CI run on main, ${formatDate(CONFORMANCE.updatedAt, lang)}.`}{" "}
          {pending.length ? t`${pending.join(", ")}: built next, against the same suite.` : ""}
        </p>
      </div>
    </section>
  );
}
