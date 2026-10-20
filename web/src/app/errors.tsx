import { Button, Page } from "@abrycta/akari/react";
import { useLingui } from "@lingui/react/macro";
import { type ErrorComponentProps, Link } from "@tanstack/react-router";
import { useEffect } from "react";

export function NotFound() {
  const { t } = useLingui();
  useEffect(() => {
    document.title = `${t`Not found`} · Typhoon Replay`;
  }, [t]);
  return (
    <Page eyebrow="404" title={t`This page blew away`} lede={t`There is nothing at this address. The storm id may be wrong, or the storm is not in the archive yet.`}>
      <div className="flex flex-wrap gap-3">
        <Button asChild>
          <Link to="/">{t`Home`}</Link>
        </Button>
        <Button asChild variant="outline">
          <Link to="/storms">{t`Browse storms`}</Link>
        </Button>
      </div>
    </Page>
  );
}

export function RouteError({ error, reset }: ErrorComponentProps) {
  const { t } = useLingui();
  return (
    <Page eyebrow={t`Error`} title={t`Something went wrong`} lede={t`The page failed to render. Reloading usually helps.`}>
      <pre className="overflow-auto rounded-sm bg-muted p-3 text-xs">{error instanceof Error ? error.message : String(error)}</pre>
      <div className="flex gap-3">
        <Button onClick={reset}>{t`Try again`}</Button>
        <Button asChild variant="outline">
          <Link to="/">{t`Home`}</Link>
        </Button>
      </div>
    </Page>
  );
}
