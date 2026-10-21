import { useLingui } from "@lingui/react/macro";

/** Eight compass directions, as "about 180 km north-east of the track". */
export function useCompassNames(): string[] {
  const { t } = useLingui();
  return [t`north`, t`north-east`, t`east`, t`south-east`, t`south`, t`south-west`, t`west`, t`north-west`];
}
