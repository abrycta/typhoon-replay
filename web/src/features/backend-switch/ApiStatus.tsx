import { Alert, AlertDescription, AlertTitle, Button } from "@abrycta/akari/react";
import { useLingui } from "@lingui/react/macro";

import { type HealthState, selectBackend, useBackends } from "@/api";

/** Inline notice for features that need the API: explains waking/down and offers mock mode. */
export function ApiStatus({ state }: { state: HealthState }) {
  const { t } = useLingui();
  const { backends, selected } = useBackends();
  const name = backends.find((b) => b.id === selected)?.label ?? selected;
  if (state === "up" || state === "checking" || state === "asleep" || state === "unknown") return null;
  return (
    <Alert data-testid="api-status">
      <AlertTitle>{state === "waking" ? t`Waking the ${name} API…` : t`The ${name} API is unavailable`}</AlertTitle>
      <AlertDescription>
        <p>
          {state === "waking"
            ? t`Free-tier servers sleep after 15 minutes idle; the first request can take 30–60 seconds. Replays and search keep working meanwhile.`
            : t`Replays, search and compare do not need it. You can try another backend, or the mock that runs in your browser.`}
        </p>
        {selected !== "mock" ? (
          <Button size="sm" variant="outline" className="mt-2" onClick={() => selectBackend("mock")}>
            {t`Use the mock backend`}
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
