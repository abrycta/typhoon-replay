import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, useLang } from "@abrycta/akari/react";
import { useLingui } from "@lingui/react/macro";
import { Fragment, type ReactNode } from "react";

import type { BackendId } from "@/shared/config/config";
import { formatDate } from "@/shared/lib/time";

import { type BackendConformance, CONFORMANCE, type PassCount, RACE_BACKENDS, type SchemathesisFailure } from "./catalogue";

const OK = "text-success";
const LINK = "underline underline-offset-2 hover:text-foreground";

/** Failures grouped by check ("ST202 Schema-valid request rejected" → its operations), in report order. */
function byCheck(failures: SchemathesisFailure[]): [string, string[]][] {
  const groups = new Map<string, string[]>();
  for (const f of failures) {
    const check = f.code ? `${f.code} ${f.title}` : f.title;
    groups.set(check, [...(groups.get(check) ?? []), f.operation]);
  }
  return [...groups];
}

/**
 * Contract conformance per backend. The test rows come from conformance.json, which CI generates from each
 * backend's latest passing run on main before every build; cold start is hand-measured.
 */
export function ConformanceTable({ labels }: { labels: Record<BackendId, string> }) {
  const { t } = useLingui();
  const { lang } = useLang();
  const nf = new Intl.NumberFormat(lang === "ja" ? "ja-JP" : "en-GB");
  const next = <span className="text-muted-foreground">{t`next`}</span>;
  const none = <span className="text-muted-foreground">—</span>;
  const pass = (p?: PassCount) => {
    if (!p) return undefined;
    if (p.failed) {
      const failed = nf.format(p.failed);
      const total = nf.format(p.total);
      return <span className="text-destructive">{t`${failed} failures in ${total}`}</span>;
    }
    return <span className={OK}>{`${nf.format(p.passed ?? p.total)} / ${nf.format(p.total)}`}</span>;
  };
  const backends = RACE_BACKENDS.map((id) => ({ id, b: CONFORMANCE.backends[id] }));
  const rows: { label: string; cell: (b: BackendConformance) => ReactNode }[] = [
    { label: t`Scenario tests (paging, caching, errors, live stream)`, cell: (b) => pass(b.ci?.scenarios) ?? next },
    { label: t`Generated API cases (Schemathesis, gating run)`, cell: (b) => pass(b.ci?.generated) ?? next },
    {
      label: t`Generated API cases, every check (informational)`,
      cell: (b) => (b.ci ? (pass(b.ci.full) ?? <span className="text-muted-foreground">{t`not run`}</span>) : next),
    },
    { label: t`Cold start on free hosting`, cell: (b) => (b.coldStartS !== undefined ? `≈ ${b.coldStartS} s` : none) },
  ];
  const measured = backends.filter(({ b }) => b.ci);
  const excluded = [...new Set(measured.flatMap(({ b }) => b.ci?.generated.excludedChecks ?? []))].join(", ");
  const failing = measured.filter(({ b }) => b.ci?.full?.failures.length);
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
                {backends.map(({ id, b }) => (
                  <TableCell key={id} className="font-mono tabular-nums">
                    {r.cell(b)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <div className="mt-2 grid gap-1 text-xs text-muted-foreground" data-testid="conformance-notes">
          {measured.length > 0 && (
            <p data-testid="conformance-runs">
              {t`Test rows: each backend's latest passing CI run on main:`}{" "}
              {measured.map(({ id, b }, i) => (
                <Fragment key={id}>
                  {i > 0 && ", "}
                  {labels[id]}{" "}
                  <a className={LINK} href={b.ci?.run.url} target="_blank" rel="noreferrer">
                    {formatDate(b.ci?.run.date ?? "", lang)}
                  </a>
                </Fragment>
              ))}
              .
            </p>
          )}
          {excluded && (
            <p>
              {t`The gating run leaves out the ${excluded} check: the contract can't yet rule out some generated requests (a cursor made for another sort, a season combined with from/to), which the backends answer with 400. The every-check run beside it does not gate the build.`}
            </p>
          )}
          {failing.length > 0 && (
            <ul className="grid gap-0.5" data-testid="conformance-failures">
              {failing.map(({ id, b }) => {
                const label = labels[id];
                return (
                  <li key={id}>
                    {t`${label}, every check:`}{" "}
                    {byCheck(b.ci?.full?.failures ?? []).map(([check, ops], i) => (
                      <Fragment key={check}>
                        {i > 0 && "; "}
                        {check} <span className="font-mono">({ops.join(", ")})</span>
                      </Fragment>
                    ))}
                  </li>
                );
              })}
            </ul>
          )}
          <p>{t`Cold start is measured by hand, not by CI.`}</p>
        </div>
      </div>
    </section>
  );
}
