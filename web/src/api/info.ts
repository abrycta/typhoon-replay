// Last API response metadata (X-Backend-Impl, latency), shown in the footer.
import { useSyncExternalStore } from "react";

export interface ResponseInfo {
  impl?: string;
  implVersion?: string;
  contractVersion?: string;
  requestId?: string;
  status: number;
  ms: number;
  at: number;
}

let last: ResponseInfo | undefined;
const listeners = new Set<() => void>();

export function recordResponse(info: ResponseInfo) {
  last = info;
  for (const l of listeners) l();
}

export function useLastResponse(): ResponseInfo | undefined {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => last,
    () => undefined,
  );
}
