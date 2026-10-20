import { useLingui } from "@lingui/react/macro";

import type { HealthState } from "@/api";

export function useHealthLabel() {
  const { t } = useLingui();
  return (s: HealthState) => ({ up: t`up`, checking: t`checking`, waking: t`waking up`, asleep: t`asleep`, unknown: t`asleep`, down: t`down` })[s];
}
