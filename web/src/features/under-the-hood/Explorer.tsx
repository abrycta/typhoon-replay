import { Button, Label, NativeSelect, NativeSelectOption, Spinner } from "@abrycta/akari/react";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useRef, useState } from "react";

import { type ApiResult, sendRequest } from "@/api";
import type { BackendId } from "@/shared/config/config";

import { ENDPOINTS, type EndpointId, RACE_BACKENDS } from "./catalogue";
import { formatMs } from "./format";

const MAX_LINES = 400;

function pretty(body: unknown): string {
  const text = JSON.stringify(body, null, 2) ?? "";
  const lines = text.split("\n");
  return lines.length > MAX_LINES ? `${lines.slice(0, MAX_LINES).join("\n")}\n…` : text;
}

/** One request to one backend, shown in full: request line, status, the edge/implementation headers, the JSON. */
export function Explorer({ labels, baseUrlOf }: { labels: Record<BackendId, string>; baseUrlOf: (id: BackendId) => string }) {
  const { t } = useLingui();
  const [backend, setBackend] = useState<BackendId>("java");
  const [endpoint, setEndpoint] = useState<EndpointId>("meta");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<ApiResult | undefined>();
  const ctrl = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => ctrl.current?.abort(), []);
  const requestLine = `GET ${baseUrlOf(backend)}${ENDPOINTS[endpoint].path}`;

  const send = async () => {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setBusy(true);
    try {
      setRes(await sendRequest(baseUrlOf(backend), ENDPOINTS[endpoint].path, { signal: c.signal }));
    } catch {
      /* aborted */
    } finally {
      if (!c.signal.aborted) setBusy(false);
    }
  };

  const hint =
    res?.kind === "waking"
      ? t`The backend is waking up (about a minute on free hosting). Send again in ${res.retryAfterS ?? 20} s.`
      : res?.kind === "not-deployed"
        ? t`This backend is not deployed yet.`
        : res?.kind === "paused"
          ? t`This backend is paused until next month to stay within its free hosting hours.`
        : res?.status === 0
          ? t`No answer (network error).`
          : "";

  return (
    <section aria-labelledby="explore-h" className="grid gap-3">
      <p className="font-mono text-xs tracking-[0.08em] text-muted-foreground uppercase">{t`Explore`}</p>
      <h2 id="explore-h" className="font-heading text-2xl font-semibold text-balance">
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
        <p className="font-mono text-[13px] break-all" data-testid="explore-request">
          {requestLine}
        </p>
        <div aria-live="polite" className="grid gap-1 font-mono text-[13px]" data-testid="explore-status">
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
