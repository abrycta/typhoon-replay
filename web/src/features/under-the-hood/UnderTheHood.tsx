import { useLingui } from "@lingui/react/macro";
import { useEffect, useMemo } from "react";

import { wakePing } from "@/api";
import type { BackendId } from "@/shared/config/config";
import { useAppConfig } from "@/shared/config/context";

import { RACE_BACKENDS } from "./catalogue";
import { ConformanceTable } from "./ConformanceTable";
import { Explorer } from "./Explorer";
import { HowItWorks } from "./HowItWorks";
import { Race } from "./Race";
import { useRace } from "./use-race";
import { SLEEPING_BACKENDS, useWakeCopy } from "./wake-copy";

const DEFAULT_LABELS: Record<BackendId, string> = { java: "Java", node: "Node", rust: "Rust", go: "Go" };

/**
 * "Tech" (route /under-the-hood): the one page that talks to the API. Race the same question on all four backends, explore one
 * endpoint, and read the conformance figures. Opening the page wakes the backends that sleep (Java and Go) with one
 * idle-time ping each.
 */
export function UnderTheHood() {
  const { t } = useLingui();
  const cfg = useAppConfig();
  const labels = useMemo(() => ({ ...DEFAULT_LABELS, ...Object.fromEntries(cfg.backends.map((b) => [b.id, b.label])) }) as Record<BackendId, string>, [cfg.backends]);
  const wake = useWakeCopy(labels);
  const baseUrlOf = useMemo(() => {
    const m = new Map(cfg.backends.map((b) => [b.id, b.baseUrl]));
    return (id: BackendId) => m.get(id) ?? `/api/${id}`;
  }, [cfg.backends]);
  const race = useRace(RACE_BACKENDS, { baseUrlOf });
  const { hint } = race;

  // Wake-on-entry, this page only: one GET /healthz to each backend that sleeps (Java and Go on Render) at idle
  // priority, so a sleeping instance is already starting by the time the visitor presses "Run". Each answer
  // decorates that idle lane. Node and Rust run on Workers and never sleep, so they get no ping.
  useEffect(() => {
    const c = new AbortController();
    for (const id of SLEEPING_BACKENDS) {
      void wakePing(baseUrlOf(id), c.signal).then((r) => {
        if (!r || c.signal.aborted || r.kind === "error") return;
        hint(id, r.kind);
      });
    }
    return () => c.abort();
  }, [baseUrlOf, hint]);

  const facts = [
    { k: t`Contract`, v: t`OpenAPI 3.1, one spec, checked for breaking changes in CI` },
    { k: t`Proof`, v: t`One conformance suite runs against every backend` },
    { k: t`Hosting`, v: wake.hostingFact },
    { k: t`Edge`, v: t`Answers are cached at Cloudflare, so repeat queries are instant` },
  ];

  return (
    <div className="mx-auto grid max-w-ak-page gap-14 px-ak-gutter py-10">
      <section className="grid gap-3">
        <p className="font-mono text-xs tracking-[0.08em] text-muted-foreground uppercase">{t`Tech`}</p>
        <h1 className="font-heading text-ak-title font-semibold text-balance">{t`One API, four languages`}</h1>
        <p className="max-w-[66ch] text-muted-foreground">
          {t`Almost everything on Replay comes from ready-made files. The storm tracks, wind maps and town lists are prepared ahead of time and stored online, so the site loads without waiting for a server. This page is the exception.`}
        </p>
        <p className="max-w-[66ch] text-muted-foreground">
          {t`Behind it sits a small API: a service that answers questions such as "Which storms passed near Tacloban?" We wrote down exactly how its answers must look in one shared rulebook, the contract, then built the service four times, in Java, Node, Rust and Go. A shared set of tests checks that all four keep the same rules.`}
        </p>
        <p className="max-w-[66ch] text-muted-foreground">
          {t`Press "Run on all four" to send the same question to every version and compare the answers. They should match. Some versions run on free hosting that sleeps when nobody is using it, so the first answer can be slow while a server wakes up. The page waits for it on its own.`}
        </p>
        <dl className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
          {facts.map((f) => (
            <div key={f.k} className="border-t-2 border-primary pt-2 text-sm">
              <dt className="font-mono text-ak-2xs tracking-[0.06em] text-muted-foreground uppercase">{f.k}</dt>
              <dd className="m-0">{f.v}</dd>
            </div>
          ))}
        </dl>
      </section>
      <HowItWorks labels={labels} />
      <Race race={race} labels={labels} />
      <Explorer labels={labels} baseUrlOf={baseUrlOf} />
      <ConformanceTable labels={labels} />
    </div>
  );
}
