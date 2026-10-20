import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";

import { type ApiResult, type MatchState, matchStates, sendRequest, sendUntilAwake } from "@/api";
import type { BackendId } from "@/shared/config/config";

export type LaneStatus = "idle" | "running" | "waking" | "ok" | "not-deployed" | "error";

export interface LaneState {
  id: BackendId;
  status: LaneStatus;
  /** performance.now() when the run started (for the live elapsed time). */
  startedAt?: number;
  /** Total time to the final answer, wake-up included. */
  totalMs?: number;
  /** The final request's own round trip. */
  lastMs?: number;
  woke?: boolean;
  attempts?: number;
  body?: unknown;
  reason?: string;
  /** Order in which lanes answered (1 = first). */
  answeredRank?: number;
}

type Action =
  | { type: "start"; ids: BackendId[]; at: number }
  | { type: "waking"; id: BackendId }
  | { type: "finish"; id: BackendId; result: Omit<LaneState, "id" | "answeredRank"> }
  | { type: "hint"; id: BackendId; status: LaneStatus };

interface State {
  lanes: LaneState[];
  answered: number;
  running: boolean;
  runs: number;
}

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case "start":
      return { lanes: a.ids.map((id) => ({ id, status: "running", startedAt: a.at })), answered: 0, running: true, runs: s.runs + 1 };
    case "waking":
      return { ...s, lanes: s.lanes.map((l) => (l.id === a.id && l.status === "running" ? { ...l, status: "waking" } : l)) };
    case "finish": {
      const answered = a.result.status === "ok" ? s.answered + 1 : s.answered;
      const lanes = s.lanes.map((l) => (l.id === a.id ? { ...l, ...a.result, answeredRank: a.result.status === "ok" ? answered : undefined } : l));
      return { ...s, lanes, answered, running: lanes.some((l) => l.status === "running" || l.status === "waking") };
    }
    case "hint":
      // A pre-run hint (from the wake-up ping) only decorates an idle lane.
      return { ...s, lanes: s.lanes.map((l) => (l.id === a.id && l.status === "idle" ? { ...l, status: a.status } : l)) };
  }
}

export interface RaceOptions {
  baseUrlOf: (id: BackendId) => string;
  capMs?: number;
}

/** Sends one request to every backend in parallel and follows each until it answers or is known to be down. */
export function useRace(ids: readonly BackendId[], opts: RaceOptions) {
  const [state, dispatch] = useReducer(reducer, undefined, () => ({ lanes: ids.map((id) => ({ id, status: "idle" as const })), answered: 0, running: false, runs: 0 }));
  const ctrl = useRef<AbortController | undefined>(undefined);
  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  });

  useEffect(() => () => ctrl.current?.abort(), []);

  const run = useCallback(
    (path: string) => {
      ctrl.current?.abort();
      const c = new AbortController();
      ctrl.current = c;
      dispatch({ type: "start", ids: [...ids], at: performance.now() });
      for (const id of ids) {
        const base = optsRef.current.baseUrlOf(id);
        void sendUntilAwake(() => sendRequest(base, path, { signal: c.signal }), {
          signal: c.signal,
          capMs: optsRef.current.capMs,
          onProgress: () => dispatch({ type: "waking", id }),
        })
          .then((o) => {
            if (c.signal.aborted) return;
            const last: ApiResult = o.last;
            dispatch({
              type: "finish",
              id,
              result: {
                status: o.outcome,
                totalMs: o.totalMs,
                lastMs: last.ms,
                woke: o.woke,
                attempts: o.attempts,
                body: o.outcome === "ok" ? last.body : undefined,
                reason: o.reason,
              },
            });
          })
          .catch(() => {
            /* aborted: a newer run or leaving the page */
          });
      }
    },
    [ids],
  );

  const hint = useCallback((id: BackendId, status: LaneStatus) => dispatch({ type: "hint", id, status }), []);

  const matches: Record<string, MatchState> = useMemo(
    () => matchStates(Object.fromEntries(state.lanes.filter((l) => l.status === "ok").map((l) => [l.id, l.body]))),
    [state.lanes],
  );
  const first = useMemo(() => state.lanes.find((l) => l.answeredRank === 1), [state.lanes]);
  return { ...state, matches, first, run, hint };
}
