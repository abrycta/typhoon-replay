import { Button, Label, NativeSelect, NativeSelectOption } from "@abrycta/akari/react";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";

import type { MatchState } from "@/api";
import type { BackendId } from "@/shared/config/config";

import { CONFORMANCE, QUESTIONS, type QuestionId } from "./catalogue";
import { formatMs } from "./format";
import { ResultTable } from "./ResultTable";
import type { LaneState, LaneStatus, useRace } from "./use-race";

/** Re-render every `ms` while `active` (the live elapsed time of waiting lanes). */
function useTick(active: boolean, ms = 500) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(performance.now()), ms);
    return () => clearInterval(id);
  }, [active, ms]);
  return now;
}

const CHIP: Record<LaneStatus, string> = {
  idle: "text-muted-foreground",
  running: "text-muted-foreground",
  waking: "text-[var(--warning,#8a5a12)] dark:text-[var(--warning,#e2b46a)]",
  ok: "text-[var(--success,#2f6b4f)] dark:text-[var(--success,#7cc4a0)]",
  "not-deployed": "text-muted-foreground",
  paused: "text-muted-foreground",
  error: "text-destructive",
};

/** The typical cold start, for the waiting bar (it fills to 95 % over this time). */
const TYPICAL_WAKE_MS = 90_000;

function Lane({ lane, label, match, now }: { lane: LaneState; label: string; match?: MatchState; now: number }) {
  const { t } = useLingui();
  const chip: Record<LaneStatus, string> = {
    idle: t`ready`,
    running: t`asking`,
    waking: t`waking up`,
    ok: t`awake`,
    "not-deployed": t`not deployed yet`,
    paused: t`paused this month`,
    error: t`error`,
  };
  // Before a run, the chip shows what the wake-up ping found (Java only); it is not an answer.
  const chipStatus: LaneStatus = lane.status === "idle" && lane.hint ? lane.hint : lane.status;
  const waiting = lane.status === "running" || lane.status === "waking";
  const elapsed = waiting && lane.startedAt !== undefined ? now - lane.startedAt : undefined;
  const pct =
    lane.status === "ok" || lane.status === "not-deployed" || lane.status === "paused" || lane.status === "error"
      ? 100
      : lane.status === "waking" && elapsed !== undefined
        ? Math.min(95, (elapsed / TYPICAL_WAKE_MS) * 100)
        : lane.status === "running"
          ? 15
          : 0;
  // The live note changes only when the lane's state changes, never with the ticking clock.
  const note =
    lane.status === "waking"
      ? t`${label} is waking up from sleep: about a minute on free hosting. This page keeps trying.`
      : lane.status === "ok"
        ? lane.woke
          ? t`${label} woke up and answered in ${formatMs(lane.totalMs ?? 0)}; the answer itself took ${formatMs(lane.lastMs ?? 0)}.`
          : t`${label} answered in ${formatMs(lane.totalMs ?? 0)}.`
        : lane.status === "not-deployed"
          ? t`${label} is not deployed yet. Nothing to wait for.`
          : lane.status === "paused"
            ? t`${label} is paused until next month to stay within its free hosting hours.`
          : lane.status === "error"
            ? lane.reason === "did not wake up in time"
              ? t`${label} did not wake up within 3 minutes.`
              : lane.httpStatus
                ? t`${label} answered HTTP ${lane.httpStatus} (${lane.reason ?? "?"}) in ${formatMs(lane.totalMs ?? 0)}.`
                : t`${label} did not answer (${lane.reason ?? "?"}).`
            : lane.hint === "ok"
              ? t`${label} is awake.`
              : lane.hint === "waking"
                ? t`${label} is waking up; opening this page started it.`
                : lane.hint === "not-deployed"
                  ? t`${label} is not deployed yet.`
                  : lane.hint === "paused"
                    ? t`${label} is paused until next month to stay within its free hosting hours.`
                  : "";
  const time =
    lane.status === "ok" || (lane.status === "error" && lane.httpStatus) ? formatMs(lane.totalMs ?? 0) : elapsed !== undefined ? formatMs(elapsed, true) : "—";
  return (
    <article className="grid min-w-0 content-start gap-2 rounded-sm border border-border bg-card p-3.5" aria-labelledby={`lane-${lane.id}-h`} data-testid={`lane-${lane.id}`}>
      <h3 id={`lane-${lane.id}-h`} className="flex items-baseline justify-between gap-2 font-heading text-lg font-semibold">
        {label}
        <span className={`rounded-full border border-current px-2 font-mono text-[11px] font-normal whitespace-nowrap ${CHIP[chipStatus]}`} data-testid={`lane-${lane.id}-state`}>
          {chip[chipStatus]}
        </span>
      </h3>
      <p className="font-mono text-[11px] text-muted-foreground">{CONFORMANCE.backends[lane.id]?.stack}</p>
      <p className="font-mono text-2xl leading-tight tabular-nums" data-testid={`lane-${lane.id}-time`}>
        {time}
      </p>
      <div className="h-1.5 overflow-hidden rounded-full bg-border" aria-hidden="true">
        <i className="block h-full bg-primary transition-[width] duration-500 ease-out motion-reduce:transition-none" style={{ width: `${pct}%` }} />
      </div>
      <p className="min-h-[2.6em] text-xs text-muted-foreground" aria-live="polite" data-testid={`lane-${lane.id}-note`}>
        {lane.status === "running" ? <span aria-hidden="true">{t`Asking…`}</span> : note}
      </p>
      <p className="text-sm" data-testid={`lane-${lane.id}-match`}>
        {match === "same" ? (
          <span className="text-[var(--success,#2f6b4f)] dark:text-[var(--success,#7cc4a0)]">{t`✓ Same result`}</span>
        ) : match === "differs" ? (
          <span className="text-destructive">{t`✗ Different result`}</span>
        ) : match === "alone" ? (
          <span className="text-muted-foreground">{t`Only answer so far`}</span>
        ) : null}
      </p>
    </article>
  );
}

export function Race({ race, labels }: { race: ReturnType<typeof useRace>; labels: Record<BackendId, string> }) {
  const { t } = useLingui();
  const [question, setQuestion] = useState<QuestionId>("town");
  const [shown, setShown] = useState<QuestionId>("town");
  const now = useTick(race.running);
  const ok = race.lanes.filter((l) => l.status === "ok");
  const differs = Object.values(race.matches).includes("differs");
  const firstLabel = race.first ? labels[race.first.id] : "";
  const agreeing = race.first ? ok.filter((l) => race.matches[l.id] === "same" || l.id === race.first?.id) : [];
  const done = race.runs > 0 && !race.running;

  return (
    <section aria-labelledby="race-h" className="grid gap-3">
      <p className="font-mono text-xs tracking-[0.08em] text-muted-foreground uppercase">{t`Race`}</p>
      <h2 id="race-h" className="font-heading text-2xl font-semibold text-balance">
        {t`Same question, four answers`}
      </h2>
      <p className="max-w-[66ch] text-muted-foreground">
        {t`A backend that has been idle for 15 minutes is asleep and takes about a minute to wake. That's expected on free hosting; this page waits for it automatically.`}
      </p>
      <div className="my-2 flex flex-wrap items-end gap-2.5">
        <div className="grid min-w-0 gap-1.5">
          <Label htmlFor="race-q">{t`Question`}</Label>
          <NativeSelect id="race-q" value={question} onChange={(e) => setQuestion(e.target.value as QuestionId)} className="max-w-full">
            <NativeSelectOption value="town">{t`Storms that passed within 100 km of Tacloban`}</NativeSelectOption>
            <NativeSelectOption value="storm">{t`Details for Haiyan (Yolanda) 2013`}</NativeSelectOption>
            <NativeSelectOption value="search">{t`Search places: "Naha"`}</NativeSelectOption>
          </NativeSelect>
        </div>
        <Button
          onClick={() => {
            setShown(question);
            race.run(QUESTIONS[question].path);
          }}
          aria-describedby="race-path"
          data-testid="race-run"
        >
          {race.running ? t`Running…` : race.runs ? t`Run again` : t`Run on all four`}
        </Button>
        <code id="race-path" className="font-mono text-xs break-all text-muted-foreground">
          GET /api/&#123;impl&#125;{QUESTIONS[question].path}
        </code>
      </div>
      <div className="grid grid-cols-1 gap-3 min-[421px]:grid-cols-2 lg:grid-cols-4" data-testid="race">
        {race.lanes.map((l) => (
          <Lane key={l.id} lane={l} label={labels[l.id]} match={race.matches[l.id]} now={now} />
        ))}
      </div>
      {race.first ? (
        <div className="mt-2 min-w-0 overflow-x-auto rounded-sm border border-border bg-card p-4" data-testid="race-results">
          <ResultTable question={shown} body={race.first.body} />
          <p className="mt-2 text-xs text-muted-foreground" data-testid="race-caption">
            {differs
              ? t`The backends disagree; showing ${firstLabel}'s answer.`
              : agreeing.length > 1
                ? t`Identical across ${agreeing.map((l) => labels[l.id]).join(", ")} (compared after normalising: key order, number formatting, timestamps, implementation fields).`
                : t`From ${firstLabel}. No other backend has answered yet.`}
          </p>
        </div>
      ) : null}
      <p className="sr-only" aria-live="polite" data-testid="race-summary">
        {done ? t`Finished: ${ok.length} of ${race.lanes.length} backends answered.` : ""}
      </p>
    </section>
  );
}
