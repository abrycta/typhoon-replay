import { useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";

import { UnderTheHood } from "@/features/under-the-hood";
import { useDocumentTitle } from "@/shared/ui/use-title";

export const Route = createFileRoute("/under-the-hood")({ component: UnderTheHoodPage });

function UnderTheHoodPage() {
  const { t } = useLingui();
  useDocumentTitle(t`Under the hood`);
  return <UnderTheHood />;
}
