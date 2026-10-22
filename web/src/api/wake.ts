// Waiting for a sleeping backend. Render's free services (Java, Go) sleep after 15 minutes idle; their measured wake time is
// the coldStartS figure in conformance.json (the Tech page's cold-start row). The edge answers 503 `backend-waking`
// with Retry-After meanwhile (edge/README.md, "Cold starts").
import { type ApiResult, REQUEST_TIMEOUT_MS } from "./request";

/** How long to keep waking a backend before giving up (a cold start is ~60-100 s; leave headroom). */
export const WAKE_CAP_MS = 3 * 60_000;
/** Shortest deadline an attempt is given, even right at the cap. */
const MIN_ATTEMPT_MS = 2000;
const MIN_DELAY_MS = 1000;
const MAX_DELAY_MS = 20_000;
/** How many times a network failure (no HTTP answer at all) is retried, after 1 s and then 2 s. */
export const NETWORK_RETRIES = 2;

export type RetryDecision =
  | { action: "done" }
  | { action: "retry"; delayMs: number; network?: true }
  | { action: "stop"; outcome: "not-deployed" | "paused" | "rate-limited" | "error"; reason: string };

/**
 * What to do after an answer: `ok` is done; `waking` retries, honouring Retry-After (else backing off 2 s × 1.5ⁿ),
 * until `capMs` would be exceeded; a network failure (status 0) is retried up to NETWORK_RETRIES times (1 s, 2 s);
 * `not-deployed`, `paused`, `rate-limited` (try again after Retry-After) and other errors stop at once (no retries).
 */
export function retryDecision(
  r: Pick<ApiResult, "kind" | "retryAfterS" | "detail" | "status">,
  elapsedMs: number,
  attempt: number,
  capMs = WAKE_CAP_MS,
  networkRetries = 0,
): RetryDecision {
  if (r.kind === "ok") return { action: "done" };
  if (r.kind === "not-deployed") return { action: "stop", outcome: "not-deployed", reason: "not deployed" };
  if (r.kind === "paused") return { action: "stop", outcome: "paused", reason: "paused this month" };
  if (r.kind === "rate-limited") return { action: "stop", outcome: "rate-limited", reason: "rate limited" };
  if (r.kind === "error" && r.status === 0 && networkRetries < NETWORK_RETRIES) {
    const delayMs = 1000 * 2 ** networkRetries;
    if (elapsedMs + delayMs <= capMs) return { action: "retry", delayMs, network: true };
  }
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
  /** Set when this retry follows a network failure rather than a sleeping backend: the retry number (1, 2). */
  networkRetry?: number;
}

export interface WakeOutcome {
  outcome: "ok" | "not-deployed" | "paused" | "rate-limited" | "error";
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

/**
 * Send until the backend answers, is known not to be deployed, fails, or the cap is reached. Each attempt gets
 * `timeoutMs`: the per-request deadline, shortened to the time left before the cap, so a stalled connection
 * cannot hold a lane past the cap. A timed-out attempt counts as a dropped connection: it is retried like any
 * network failure (NETWORK_RETRIES in all, 1 s then 2 s), each retry with a fresh deadline. It ends the wait as
 * "did not wake up in time" when it ran into the cap while waking, else, once retries are spent, as "timed out".
 */
export async function sendUntilAwake(
  send: (attempt: { timeoutMs: number }) => Promise<ApiResult>,
  opts: { signal?: AbortSignal; capMs?: number; onProgress?: (p: WakeProgress) => void; sleep?: typeof defaultSleep; now?: () => number; requestTimeoutMs?: number } = {},
): Promise<WakeOutcome> {
  const now = opts.now ?? (() => performance.now());
  const sleep = opts.sleep ?? defaultSleep;
  const capMs = opts.capMs ?? WAKE_CAP_MS;
  const t0 = now();
  let woke = false;
  let networkRetries = 0;
  for (let attempt = 0; ; attempt++) {
    const timeoutMs = Math.min(opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS, Math.max(capMs - (now() - t0), MIN_ATTEMPT_MS));
    const last = await send({ timeoutMs });
    const elapsedMs = now() - t0;
    if (last.timedOut && woke && elapsedMs >= capMs - MIN_ATTEMPT_MS)
      return { outcome: "error", last, totalMs: Math.round(elapsedMs), attempts: attempt + 1, woke, reason: "did not wake up in time" };
    const d = retryDecision(last, elapsedMs, attempt, capMs, networkRetries);
    if (d.action === "done") return { outcome: "ok", last, totalMs: Math.round(elapsedMs), attempts: attempt + 1, woke };
    if (d.action === "stop") return { outcome: d.outcome, last, totalMs: Math.round(elapsedMs), attempts: attempt + 1, woke, reason: d.reason };
    if (d.network) networkRetries++;
    else woke = true;
    opts.onProgress?.({ attempt: attempt + 1, elapsedMs, last, nextAtMs: elapsedMs + d.delayMs, ...(d.network ? { networkRetry: networkRetries } : {}) });
    await sleep(d.delayMs, opts.signal);
  }
}
