import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@abrycta/akari/react";
import { useLingui } from "@lingui/react/macro";

import type { BackendId } from "@/shared/config/config";

import { RACE_BACKENDS } from "./catalogue";

/**
 * The technical section of "Under the hood", right after the plain-language intro: how the API is built, hosted and
 * checked. Facts only, from docs/architecture/DECISIONS.md. Test counts and timings live in the conformance table
 * (generated from CI), not here.
 */
export function HowItWorks({ labels }: { labels: Record<BackendId, string> }) {
  const { t } = useLingui();

  const stacks: Record<BackendId, { stack: string; hosting: string; db: string }> = {
    java: {
      stack: "Spring Boot 4.1 · Java 25",
      hosting: t`Render free plan; sleeps after 15 minutes idle`,
      db: t`JDBC to Neon, pooled connection`,
    },
    node: {
      stack: "Hono 4.13 · TypeScript",
      hosting: t`Cloudflare Worker; never sleeps`,
      db: t`Neon serverless SQL over HTTP`,
    },
    rust: {
      stack: "Axum 0.8 · workers-rs (wasm)",
      hosting: t`Cloudflare Worker; never sleeps`,
      db: t`Neon serverless SQL over HTTP`,
    },
    go: {
      stack: "net/http · oapi-codegen · Go 1.27",
      hosting: t`Render free plan; sleeps after 15 minutes idle`,
      db: t`Neon serverless SQL over HTTP`,
    },
  };

  const topics = [
    {
      k: t`One contract`,
      v: t`The API is served under /v1, and CI lints the contract. It offers public reads only: health, metadata, storms, places, storms near a place, and a live stream. There are no accounts and no cookies.`,
    },
    {
      k: t`One database`,
      v: t`All four backends read the same Neon Postgres database with PostGIS. It scales to zero when idle.`,
    },
    {
      k: t`The edge`,
      v: t`Every request goes to this site, under /api/ plus the backend's name. A Cloudflare function in front routes it and treats all four backends alike. It serves a stored copy if a backend fails, limits requests per visitor, and answers "waking up" while a sleeping server or database starts.`,
    },
    {
      k: t`Proof`,
      v: t`The suite is language-neutral and runs in CI. It combines scenario tests with cases that Schemathesis generates from the contract. The race compares answers after normalising key order, number formatting, timestamps and implementation fields.`,
    },
    {
      k: t`Frozen code`,
      v: t`Once built, each backend is pinned to exact dependency versions, lockfiles and toolchains, and gets only security fixes. So the race always compares the same code.`,
    },
  ];

  return (
    <section aria-labelledby="how-h" className="grid gap-3">
      <p className="font-mono text-xs tracking-[0.08em] text-muted-foreground uppercase">{t`How it works`}</p>
      <h2 id="how-h" className="font-heading text-ak-subsection font-semibold text-balance">
        {t`One contract, four builds, one edge`}
      </h2>
      <dl className="grid gap-4 sm:grid-cols-2">
        {topics.map((f) => (
          <div key={f.k} className="grid content-start gap-1 text-sm">
            <dt className="font-semibold">{f.k}</dt>
            <dd className="m-0 max-w-[66ch] text-muted-foreground">{f.v}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-2 min-w-0 overflow-x-auto rounded-sm border border-border bg-card p-4" data-testid="stacks">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t`Backend`}</TableHead>
              <TableHead>{t`Stack`}</TableHead>
              <TableHead>{t`Hosting`}</TableHead>
              <TableHead>{t`Database access`}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {RACE_BACKENDS.map((id) => (
              <TableRow key={id}>
                <TableCell className="font-semibold">{labels[id]}</TableCell>
                <TableCell className="font-mono text-xs">{stacks[id].stack}</TableCell>
                <TableCell className="min-w-40 whitespace-normal">{stacks[id].hosting}</TableCell>
                <TableCell className="min-w-40 whitespace-normal">{stacks[id].db}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
