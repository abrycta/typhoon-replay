import { Page } from "@abrycta/akari/react";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { useCallback } from "react";

import { useApiBackend } from "@/api";
import { ApiStatus } from "@/features/backend-switch";
import { TownHistory, type TownUrl } from "@/features/town-history";
import { useDocumentTitle } from "@/shared/ui/use-title";

import { townSearch } from "./-search";

export const Route = createFileRoute("/town")({
  validateSearch: townSearch,
  search: { middlewares: [stripSearchParams({ radius: 100 })] },
  component: TownPage,
});

function TownPage() {
  const { t } = useLingui();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const api = useApiBackend();
  useDocumentTitle(t`Typhoons that hit my town`);
  const onUrl = useCallback((p: Partial<TownUrl>) => void navigate({ search: (prev) => ({ ...prev, ...p }), replace: true, resetScroll: false }), [navigate]);
  return (
    <Page
      eyebrow={t`Hit my town`}
      title={t`Typhoons that hit my town`}
      lede={t`Search a Philippine city or municipality, or a Japanese municipality, and list the storms that passed within a chosen distance. Answered by the API backend you pick in the header.`}
    >
      <ApiStatus state={api.state} />
      <TownHistory url={search} onUrl={onUrl} />
    </Page>
  );
}
