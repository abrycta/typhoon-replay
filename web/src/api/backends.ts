// Backend registry: which implementation serves API calls, and how healthy each one looks.
//
// Health is probed only for the backend a feature is about to use (or when the user presses "check"
// on a chip), never all four at once: Render free instances sleep after 15 minutes idle and each probe
// wakes one. Last-known states persist in localStorage so chips are informative without probing.
import { useSyncExternalStore } from "react";

import type { BackendConfig, BackendId } from "@/shared/config/config";

export type HealthState = "unknown" | "checking" | "up" | "waking" | "asleep" | "down";

export interface BackendHealth {
  state: HealthState;
  checkedAt?: number;
  lastUpAt?: number;
  ms?: number;
  detail?: string;
}

const SELECT_KEY = "tr.backend";
const HEALTH_KEY = "tr.health";
export const SLEEP_AFTER_MS = 15 * 60_000;
const PROBE_TIMEOUT_MS = 3000;
const WAKE_LIMIT_MS = 90_000;

interface State {
  backends: BackendConfig[];
  selected: BackendId;
  health: Partial<Record<BackendId, BackendHealth>>;
}

let state: State = { backends: [], selected: "java", health: {} };
const listeners = new Set<() => void>();
const inflight = new Map<BackendId, Promise<BackendHealth>>();

function emit() {
  for (const l of listeners) l();
}
function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  emit();
}

const read = <T,>(key: string): T | undefined => {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : undefined;
  } catch {
    return undefined;
  }
};
const write = (key: string, v: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage unavailable */
  }
};

/** Last-known health as displayed: an old "up" becomes "asleep" (the instance has likely slept). */
export function displayHealth(h: BackendHealth | undefined, now = Date.now()): HealthState {
  if (!h) return "asleep";
  if (h.state === "up" && h.lastUpAt && now - h.lastUpAt > SLEEP_AFTER_MS) return "asleep";
  if (h.state === "unknown") return "asleep";
  return h.state;
}

export function initBackends(backends: BackendConfig[], defaultId: BackendId, fromUrl?: string) {
  const ids = new Set(backends.map((b) => b.id));
  const saved = read<string>(SELECT_KEY);
  const pick = [fromUrl, saved, defaultId].find((x): x is BackendId => !!x && ids.has(x as BackendId)) ?? backends[0]!.id;
  const health = read<State["health"]>(HEALTH_KEY) ?? {};
  // A probe in progress when the page closed is unknown now.
  for (const h of Object.values(health)) if (h && (h.state === "checking" || h.state === "waking")) h.state = "unknown";
  state = { backends, selected: pick, health };
  emit();
}

export function selectBackend(id: BackendId) {
  if (!state.backends.some((b) => b.id === id) || id === state.selected) return;
  write(SELECT_KEY, id);
  set({ selected: id });
}

export const getSelected = () => state.selected;
export const baseUrlOf = (id: BackendId) => state.backends.find((b) => b.id === id)?.baseUrl ?? `/api/${id}`;

function setHealth(id: BackendId, h: BackendHealth) {
  const health = { ...state.health, [id]: h };
  write(HEALTH_KEY, health);
  set({ health });
}

let mockStarted: Promise<void> | undefined;
/** Mock mode: start the MSW service worker on first use (lazy chunk, never in the main bundle). */
export function ensureMock(): Promise<void> {
  mockStarted ??= import("./mocks/browser")
    .then((m) => m.startMockWorker())
    .catch((e: unknown) => {
      mockStarted = undefined; // allow a retry
      throw e;
    });
  return mockStarted;
}

type ProbeResult = { kind: "up"; ms: number } | { kind: "slow" } | { kind: "down"; detail: string } | { kind: "busy"; detail: string };

async function probeOnce(id: BackendId, fetchImpl: typeof fetch): Promise<ProbeResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  const t0 = performance.now();
  try {
    const res = await fetchImpl(`${baseUrlOf(id)}/healthz`, { signal: ctrl.signal, cache: "no-store" });
    const ms = Math.round(performance.now() - t0);
    if ([502, 503, 504].includes(res.status)) return { kind: "busy", detail: `HTTP ${res.status}` };
    if (!res.ok) return { kind: "down", detail: `HTTP ${res.status}` };
    if (!(res.headers.get("Content-Type") ?? "").includes("json")) return { kind: "down", detail: "not deployed" };
    const body = (await res.json()) as { status?: string };
    return body.status === "ok" ? { kind: "up", ms } : { kind: "down", detail: "unhealthy" };
  } catch (e) {
    if (ctrl.signal.aborted) return { kind: "slow" };
    return { kind: "down", detail: e instanceof Error ? e.message : "network error" };
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Probe one backend: checking -> up | waking (retry with backoff up to ~90 s, the Render cold start) | down.
 * Concurrent callers share one probe.
 */
export function probeBackend(id: BackendId, fetchImpl: typeof fetch = (...a) => fetch(...a), opts: { wakeLimitMs?: number } = {}): Promise<BackendHealth> {
  const existing = inflight.get(id);
  if (existing) return existing;
  const run = (async () => {
    if (id === "mock") await ensureMock();
    const startedAt = Date.now();
    const prev = state.health[id];
    setHealth(id, { ...prev, state: "checking" });
    let delay = 2000;
    for (;;) {
      const r = await probeOnce(id, fetchImpl);
      const now = Date.now();
      if (r.kind === "up") {
        const h = { state: "up" as const, checkedAt: now, lastUpAt: now, ms: r.ms };
        setHealth(id, h);
        return h;
      }
      if (r.kind === "down") {
        const h = { state: "down" as const, checkedAt: now, lastUpAt: prev?.lastUpAt, detail: r.detail };
        setHealth(id, h);
        return h;
      }
      if (now - startedAt > (opts.wakeLimitMs ?? WAKE_LIMIT_MS)) {
        const h = { state: "down" as const, checkedAt: now, lastUpAt: prev?.lastUpAt, detail: "did not wake up" };
        setHealth(id, h);
        return h;
      }
      setHealth(id, { state: "waking", checkedAt: now, lastUpAt: prev?.lastUpAt, detail: r.kind === "busy" ? r.detail : undefined });
      await sleep(delay);
      delay = Math.min(delay * 1.5, 10_000);
    }
  })().finally(() => inflight.delete(id));
  inflight.set(id, run);
  return run;
}

/** Mark a backend up after any successful API call (no extra probe needed). */
export function noteSuccess(id: BackendId) {
  const now = Date.now();
  const h = state.health[id];
  if (h?.state === "up" && h.lastUpAt && now - h.lastUpAt < 60_000) return;
  setHealth(id, { ...h, state: "up", checkedAt: now, lastUpAt: now });
}

export function useBackends(): State {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => state,
    () => state,
  );
}

/** Test helper. */
export function __resetBackends() {
  state = { backends: [], selected: "java", health: {} };
  inflight.clear();
}
