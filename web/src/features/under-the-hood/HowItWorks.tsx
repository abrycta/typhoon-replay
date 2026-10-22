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
      k: t`Static first`,
      v: t`Visitor pages read prepared files from Cloudflare Pages and a versioned dataset, so the site works even when every backend is asleep. Only this page calls the API.`,
    },
    {
      k: t`One contract`,
      v: t`The API is described once in OpenAPI 3.1 and served under /v1. CI lints the contract and fails on any breaking change. It offers public reads only (health, metadata, storms, places, storms near a place, and a live stream), with no accounts and no cookies.`,
    },
    {
      // [PERF] The Go-on-Workers CPU figure (DECISIONS.md, 2026-10-22) is left out until the perf audit reports.
      k: t`Why two hosts`,
      v: t`Render's free plan shares 750 instance hours a month across all services, so only Java and Go run there. Node and Rust run as Cloudflare Workers. Go was tried on Workers first, but it used more CPU per request than the free plan allows.`,
    },
    {
      k: t`One database`,
      v: t`All four backends read the same Neon Postgres database with PostGIS, which also scales to zero when idle.`,
    },
    {
      k: t`The edge`,
      v: t`Every request goes to this site, under /api/ plus the backend's name. A Cloudflare function in front routes it and treats all four backends alike: it caches public answers, serves a stored copy if a backend fails, limits requests per visitor, and answers "waking up" while a sleeping server or database starts.`,
    },
    {
      k: t`Proof`,
      v: t`One language-neutral test suite runs against every backend in CI: scenario tests plus cases generated from the contract with Schemathesis. The race compares answers after normalising key order, number formatting, timestamps and implementation fields.`,
    },
    {
      k: t`Frozen code`,
      v: t`Each backend is pinned once built (exact dependency versions, lockfiles and toolchains) and receives only security fixes, so the race always compares the same code.`,
    },
    {
      k: t`Free tiers only`,
      v: t`Everything runs on free plans. A daily check reads hosting hours, bandwidth, requests and database usage and opens an issue when a meter passes 70 %.`,
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
