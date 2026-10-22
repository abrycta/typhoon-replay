import { Button, Label, NativeSelect, NativeSelectOption, Spinner } from "@abrycta/akari/react";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useRef, useState } from "react";

import { type ApiResult, REQUEST_TIMEOUT_MS, sendRequest } from "@/api";
import type { BackendId } from "@/shared/config/config";

import { ENDPOINTS, type EndpointId, RACE_BACKENDS } from "./catalogue";
import { formatMs } from "./format";
import { useWakeCopy } from "./wake-copy";

/** The per-request deadline in seconds, for the "did not answer" notes. */
const timeoutS = REQUEST_TIMEOUT_MS / 1000;

const MAX_LINES = 400;

function pretty(body: unknown): string {
  const text = JSON.stringify(body, null, 2) ?? "";
  const lines = text.split("\n");
  return lines.length > MAX_LINES ? `${lines.slice(0, MAX_LINES).join("\n")}\n…` : text;
}

/** One request to one backend, shown in full: request line, status, the edge/implementation headers, the JSON. */
export function Explorer({ labels, baseUrlOf }: { labels: Record<BackendId, string>; baseUrlOf: (id: BackendId) => string }) {
  const { t } = useLingui();
  const wake = useWakeCopy(labels);
  const [backend, setBackend] = useState<BackendId>("java");
  const [endpoint, setEndpoint] = useState<EndpointId>("meta");
  const [busy, setBusy] = useState(false);
  // The last answer and the request line it answered. It is shown only while that line is still the one on
  // screen and no newer request is in flight, so a changed backend/endpoint never sits above an old response.
  const [last, setLast] = useState<{ line: string; res: ApiResult } | undefined>();
  const ctrl = useRef<AbortController | undefined>(undefined);
  const seq = useRef(0);
  useEffect(() => () => ctrl.current?.abort(), []);
  const requestLine = `GET ${baseUrlOf(backend)}${ENDPOINTS[endpoint].path}`;
  const res = !busy && last?.line === requestLine ? last.res : undefined;

  const send = async () => {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    const id = ++seq.current;
    const line = requestLine;
    setBusy(true);
    try {
      const r = await sendRequest(baseUrlOf(backend), ENDPOINTS[endpoint].path, { signal: c.signal });
      // Ignore an answer that arrives after a newer request started (out of order).
      if (id === seq.current) setLast({ line, res: r });
    } catch {
      /* aborted */
    } finally {
      if (id === seq.current) setBusy(false);
    }
  };

  const waitS = res?.retryAfterS ?? 60;
  const hint =
    res?.kind === "waking"
      ? wake.explorerWaking(backend, res.retryAfterS ?? 20)
      : res?.kind === "not-deployed"
        ? t`This backend is not deployed yet.`
        : res?.kind === "rate-limited"
          ? t`Too many requests from this address. Try again in ${waitS} s.`
        : res?.kind === "paused"
          ? t`This backend is paused until next month to stay within its free hosting hours.`
        : res?.timedOut
          ? t`No answer within ${timeoutS} seconds; the connection may have stalled.`
          : res?.status === 0
            ? t`No answer (network error).`
          : "";

  return (
    <section aria-labelledby="explore-h" className="grid gap-3">
      <p className="font-mono text-xs tracking-[0.08em] text-muted-foreground uppercase">{t`Explore`}</p>
      <h2 id="explore-h" className="font-heading text-ak-subsection font-semibold text-balance">
        {t`Try one endpoint`}
      </h2>
      <div className="grid min-w-0 gap-3 rounded-sm border border-border bg-card p-4">
        <form
          className="flex flex-wrap items-end gap-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="ex-backend">{t`Backend`}</Label>
            <NativeSelect id="ex-backend" value={backend} onChange={(e) => setBackend(e.target.value as BackendId)}>
              {RACE_BACKENDS.map((id) => (
                <NativeSelectOption key={id} value={id}>
                  {labels[id]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <div className="grid min-w-0 gap-1.5">
            <Label htmlFor="ex-endpoint">{t`Endpoint`}</Label>
            <NativeSelect id="ex-endpoint" value={endpoint} onChange={(e) => setEndpoint(e.target.value as EndpointId)} className="max-w-full">
              {(Object.keys(ENDPOINTS) as EndpointId[]).map((id) => (
                <NativeSelectOption key={id} value={id}>
                  GET {ENDPOINTS[id].path}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <Button type="submit" variant="outline" disabled={busy} data-testid="explore-send">
            {busy ? <Spinner /> : null}
            {t`Send`}
          </Button>
        </form>
        <p className="font-mono text-ak-sm break-all" data-testid="explore-request">
          {requestLine}
        </p>
        <div aria-live="polite" className="grid gap-1 font-mono text-ak-sm" data-testid="explore-status">
          {res ? (
            <>
              <p>
                HTTP {res.status || "—"} · {formatMs(res.ms)}
              </p>
              <p>
                X-Backend-Impl: {res.impl ?? "—"} · X-Edge-Cache: {res.edgeCache ?? "—"}
              </p>
              {hint ? <p className="font-sans text-sm text-muted-foreground">{hint}</p> : null}
            </>
          ) : busy ? (
            <p className="font-sans text-sm text-muted-foreground">{t`Sending…`}</p>
          ) : (
            <p className="font-sans text-sm text-muted-foreground">{t`Press Send to see the response.`}</p>
          )}
        </div>
        {res?.body !== undefined ? (
          <pre className="max-h-[28rem] overflow-auto rounded-sm border border-border bg-background p-3 font-mono text-xs leading-relaxed" tabIndex={0} aria-label={t`Response body`} data-testid="explore-body">
            {pretty(res.body)}
          </pre>
        ) : null}
      </div>
    </section>
  );
}
