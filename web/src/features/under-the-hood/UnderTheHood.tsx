import { useLingui } from "@lingui/react/macro";
import { useEffect, useMemo } from "react";

import { wakePing } from "@/api";
import type { BackendId } from "@/shared/config/config";
import { useAppConfig } from "@/shared/config/context";

import { RACE_BACKENDS } from "./catalogue";
import { ConformanceTable } from "./ConformanceTable";
import { Explorer } from "./Explorer";
import { Race } from "./Race";
import { useRace } from "./use-race";

const DEFAULT_LABELS: Record<BackendId, string> = { java: "Java", node: "Node", rust: "Rust", go: "Go" };

/**
 * "Under the hood": the one page that talks to the API. Race the same question on all four backends, explore one
 * endpoint, and read the conformance figures. Opening the page wakes the Java backend with one idle-time ping.
 */
export function UnderTheHood() {
  const { t } = useLingui();
  const cfg = useAppConfig();
  const labels = useMemo(() => ({ ...DEFAULT_LABELS, ...Object.fromEntries(cfg.backends.map((b) => [b.id, b.label])) }) as Record<BackendId, string>, [cfg.backends]);
  const baseUrlOf = useMemo(() => {
    const m = new Map(cfg.backends.map((b) => [b.id, b.baseUrl]));
    return (id: BackendId) => m.get(id) ?? `/api/${id}`;
  }, [cfg.backends]);
  const race = useRace(RACE_BACKENDS, { baseUrlOf });
  const { hint } = race;

  // Wake-on-entry, this page only: one GET /healthz to the Java backend at idle priority, so a sleeping
  // instance is already starting by the time the visitor presses "Run". Its answer decorates the idle lane.
  useEffect(() => {
    const c = new AbortController();
    void wakePing(baseUrlOf("java"), c.signal).then((r) => {
      if (!r || c.signal.aborted || r.kind === "error") return;
      hint("java", r.kind);
    });
    return () => c.abort();
  }, [baseUrlOf, hint]);

  const facts = [
    { k: t`Contract`, v: t`OpenAPI 3.1, one spec, checked for breaking changes in CI` },
    { k: t`Proof`, v: t`One conformance suite runs against every backend` },
    { k: t`Hosting`, v: t`Free tier: servers sleep when idle and wake on demand` },
    { k: t`Edge`, v: t`Answers are cached at Cloudflare, so repeat queries are instant` },
  ];

  return (
    <div className="mx-auto grid max-w-[1080px] gap-14 px-4 py-10">
      <section className="grid gap-3">
        <p className="font-mono text-xs tracking-[0.08em] text-muted-foreground uppercase">{t`Under the hood`}</p>
        <h1 className="font-heading text-[clamp(30px,5vw,44px)] leading-[1.15] font-semibold text-balance">{t`One API, four languages`}</h1>
        <p className="max-w-[66ch] text-muted-foreground">
          {t`Everything else on this site runs from static files, so it never waits for a server. This page is the exception: it talks to the API, which is written once as an OpenAPI contract and implemented four times, in Java, Node, Rust and Go. Run a query on all four and watch them agree.`}
        </p>
        <dl className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
          {facts.map((f) => (
            <div key={f.k} className="border-t-2 border-primary pt-2 text-sm">
              <dt className="font-mono text-[11px] tracking-[0.06em] text-muted-foreground uppercase">{f.k}</dt>
              <dd className="m-0">{f.v}</dd>
            </div>
          ))}
        </dl>
      </section>
      <Race race={race} labels={labels} />
      <Explorer labels={labels} baseUrlOf={baseUrlOf} />
      <ConformanceTable labels={labels} />
    </div>
  );
}
