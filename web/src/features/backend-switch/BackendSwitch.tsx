import { Button, Popover, PopoverContent, PopoverTrigger } from "@abrycta/akari/react";
import { useLingui } from "@lingui/react/macro";
import { RefreshCwIcon, ServerIcon } from "lucide-react";

import { displayHealth, type HealthState, probeBackend, selectBackend, useBackends, useLastResponse } from "@/api";
import type { BackendId } from "@/shared/config/config";

import { useHealthLabel } from "./health-label";

const DOT: Record<HealthState, string> = {
  up: "bg-[var(--success,#2f7d4f)]",
  checking: "bg-muted-foreground animate-pulse motion-reduce:animate-none",
  waking: "bg-[var(--warning,#b7791f)] animate-pulse motion-reduce:animate-none",
  asleep: "bg-muted-foreground/60",
  unknown: "bg-muted-foreground/60",
  down: "bg-destructive",
};

export function StatusDot({ state }: { state: HealthState }) {
  return <span aria-hidden="true" className={`inline-block size-2 shrink-0 rounded-full ${DOT[state]}`} />;
}

/**
 * "Served by" switch: one chip per backend with its last-known state. Opening it probes nothing; each chip
 * has its own "check" button, so the four free-tier instances are never all woken at once.
 */
export function BackendSwitch() {
  const { t } = useLingui();
  const { backends, selected, health } = useBackends();
  const label = useHealthLabel();
  const current = backends.find((b) => b.id === selected);
  const state = displayHealth(health[selected]);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" data-testid="backend-switch" aria-label={t`Served by ${current?.label ?? selected}, ${label(state)}. Change backend`}>
          <ServerIcon />
          <span className="hidden sm:inline">{current?.label}</span>
          <StatusDot state={state} />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80" align="end">
        <div className="grid gap-3">
          <div>
            <p className="text-sm font-semibold">{t`Served by`}</p>
            <p className="text-xs text-muted-foreground">
              {t`Four interchangeable backends implement one contract. Free-tier servers sleep after 15 minutes idle; the first request can take 30–60 s. The replay never needs them.`}
            </p>
          </div>
          <ul className="grid gap-1.5" aria-label={t`Backends`}>
            {backends.map((b) => {
              const s = displayHealth(health[b.id]);
              const h = health[b.id];
              return (
                <li key={b.id} className="flex items-center gap-2">
                  <Button
                    variant={b.id === selected ? "default" : "ghost"}
                    size="sm"
                    className="flex-1 justify-start"
                    aria-pressed={b.id === selected}
                    onClick={() => selectBackend(b.id as BackendId)}
                    data-testid={`backend-${b.id}`}
                  >
                    <StatusDot state={s} />
                    {b.label}
                    <span className="ml-auto text-xs font-normal opacity-80">
                      {label(s)}
                      {s === "up" && h?.ms !== undefined ? ` · ${h.ms} ms` : ""}
                    </span>
                  </Button>
                  <Button variant="outline" size="icon-sm" aria-label={t`Check ${b.label} now`} onClick={() => void probeBackend(b.id as BackendId)}>
                    <RefreshCwIcon />
                  </Button>
                </li>
              );
            })}
          </ul>
          {health[selected]?.detail && state === "down" ? <p className="text-xs text-muted-foreground">{t`Last check: ${health[selected]?.detail ?? ""}`}</p> : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Footer line: the implementation that answered the last API call (X-Backend-Impl) and its latency. */
export function ServedByFooter() {
  const { t } = useLingui();
  const last = useLastResponse();
  if (!last?.impl) return <span data-testid="served-by">{t`API: not used yet`}</span>;
  return (
    <span data-testid="served-by">
      {t`Served by ${last.impl}`} · {last.ms} ms{last.contractVersion ? ` · ${t`contract ${last.contractVersion}`}` : ""}
    </span>
  );
}
