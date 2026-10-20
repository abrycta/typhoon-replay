import { Page } from "@abrycta/akari/react";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";

import { StormBrowser } from "@/features/storm-search";
import { useDocumentTitle } from "@/shared/ui/use-title";

import { catalogSearch } from "./-search";

export const Route = createFileRoute("/storms")({
  validateSearch: catalogSearch,
  component: StormsPage,
});

function StormsPage() {
  const { t } = useLingui();
  const filter = Route.useSearch();
  const navigate = Route.useNavigate();
  useDocumentTitle(t`Storms`);
  return (
    <Page eyebrow={t`Catalogue`} title={t`Storms`} lede={t`Typhoons that made landfall in, or passed close to, the Philippines and Japan.`}>
      <StormBrowser filter={filter} onFilter={(f) => void navigate({ search: f, replace: true })} />
    </Page>
  );
}
