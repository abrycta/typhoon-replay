// Waiting for a sleeping backend. Render's free services sleep after 15 minutes idle and take about a minute
// to wake; the edge answers 503 `backend-waking` with Retry-After meanwhile (edge/README.md, "Cold starts").
import type { ApiResult } from "./request";

/** How long to keep waking a backend before giving up (a cold start is ~60-100 s; leave headroom). */
export const WAKE_CAP_MS = 3 * 60_000;
const MIN_DELAY_MS = 1000;
const MAX_DELAY_MS = 20_000;

export type RetryDecision =
  | { action: "done" }
  | { action: "retry"; delayMs: number }
  | { action: "stop"; outcome: "not-deployed" | "paused" | "error"; reason: string };

/**
 * What to do after an answer: `ok` is done; `waking` retries, honouring Retry-After (else backing off 2 s × 1.5ⁿ),
 * until `capMs` would be exceeded; `not-deployed`, `paused` and errors stop at once (no retries).
 */
export function retryDecision(r: Pick<ApiResult, "kind" | "retryAfterS" | "detail" | "status">, elapsedMs: number, attempt: number, capMs = WAKE_CAP_MS): RetryDecision {
  if (r.kind === "ok") return { action: "done" };
  if (r.kind === "not-deployed") return { action: "stop", outcome: "not-deployed", reason: "not deployed" };
  if (r.kind === "paused") return { action: "stop", outcome: "paused", reason: "paused this month" };
  if (r.kind === "error") return { action: "stop", outcome: "error", reason: r.detail ?? `HTTP ${r.status}` };
  const backoff = Math.min(2000 * 1.5 ** attempt, MAX_DELAY_MS);
  const delayMs = Math.min(Math.max(r.retryAfterS !== undefined ? r.retryAfterS * 1000 : backoff, MIN_DELAY_MS), MAX_DELAY_MS);
  if (elapsedMs + delayMs > capMs) return { action: "stop", outcome: "error", reason: "did not wake up in time" };
  return { action: "retry", delayMs };
}

export interface WakeProgress {
  attempt: number;
  elapsedMs: number;
  last: ApiResult;
  /** When the next attempt is due (ms since start), while waiting. */
  nextAtMs?: number;
}

export interface WakeOutcome {
  outcome: "ok" | "not-deployed" | "paused" | "error";
  /** The final answer. */
  last: ApiResult;
  /** Total time from the first request to the final answer. */
  totalMs: number;
  attempts: number;
  /** True when the backend had to be woken (at least one `waking` answer). */
  woke: boolean;
  reason?: string;
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(id);
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });

/** Send until the backend answers, is known not to be deployed, fails, or the cap is reached. */
export async function sendUntilAwake(
  send: () => Promise<ApiResult>,
  opts: { signal?: AbortSignal; capMs?: number; onProgress?: (p: WakeProgress) => void; sleep?: typeof defaultSleep; now?: () => number } = {},
): Promise<WakeOutcome> {
  const now = opts.now ?? (() => performance.now());
  const sleep = opts.sleep ?? defaultSleep;
  const t0 = now();
  let woke = false;
  for (let attempt = 0; ; attempt++) {
    const last = await send();
    const elapsedMs = now() - t0;
    const d = retryDecision(last, elapsedMs, attempt, opts.capMs);
    if (d.action === "done") return { outcome: "ok", last, totalMs: Math.round(elapsedMs), attempts: attempt + 1, woke };
    if (d.action === "stop") return { outcome: d.outcome, last, totalMs: Math.round(elapsedMs), attempts: attempt + 1, woke, reason: d.reason };
    woke = true;
    opts.onProgress?.({ attempt: attempt + 1, elapsedMs, last, nextAtMs: elapsedMs + d.delayMs });
    await sleep(d.delayMs, opts.signal);
  }
}
