// Public surface of the API layer. Only the under-the-hood feature may import it (lint rule): every visitor
// page runs from static files. Nothing outside src/api may import src/api/generated or call a backend.
import { type ApiResult, sendRequest } from "./request";

export { bodyKey, type MatchState, matchStates, normaliseBody } from "./compare";
export { type ApiPath, type ApiResult, classify, type ContractPath, type ResultKind, sendRequest, type SendOptions } from "./request";
export { NETWORK_RETRIES, retryDecision, type RetryDecision, sendUntilAwake, WAKE_CAP_MS, type WakeOutcome, type WakeProgress } from "./wake";

/** One GET /healthz at low priority, started when the browser is idle: wakes a sleeping backend early. */
export function wakePing(baseUrl: string, signal?: AbortSignal): Promise<ApiResult | undefined> {
  return new Promise((resolve) => {
    const go = () => {
      if (signal?.aborted) return resolve(undefined);
      sendRequest(baseUrl, "/healthz", { priority: "low", signal }).then(resolve, () => resolve(undefined));
    };
    if (typeof requestIdleCallback === "function") requestIdleCallback(go, { timeout: 2000 });
    else setTimeout(go, 200);
  });
}
