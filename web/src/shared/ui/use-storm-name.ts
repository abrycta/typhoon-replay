import { useLang } from "@abrycta/akari/react";
import { useLingui } from "@lingui/react/macro";
import { useCallback } from "react";

import { type Named, stormLabel, stormTitle } from "../lib/names";
import { formatMonth } from "../lib/time";

/** What a storm name needs: `startedAt` (and `designation`) describe storms with no name at all. */
export type NamedStorm = Named & { sid?: string; startedAt?: string; designation?: string };

/**
 * The storm's name as plain text (page titles, pickers, links, aria labels), following `stormLabel`:
 * "Haiyan (Yolanda)", "Crising (PAGASA name)", "Typhoon No. 7 (JMA number)", "Unnamed storm · 03W · Feb 1940".
 * Never a bare "Unnamed".
 */
export function useStormName(): (s: NamedStorm) => string {
  const { t } = useLingui();
  const { lang } = useLang();
  return useCallback(
    (s: NamedStorm) => {
      const label = stormLabel({ ...s, startedAt: s.startedAt ?? "" });
      const sep = lang === "ja" ? "" : " "; // the Japanese markers open with a full-width bracket
      switch (label.kind) {
        case "international":
          return stormTitle(s, lang);
        case "pagasa":
          return `${label.name}${sep}${t`(PAGASA name)`}`;
        case "jma": {
          const { number } = label;
          return `${lang === "ja" ? label.ja : t`Typhoon No. ${number}`}${sep}${t`(JMA number)`}`;
        }
        case "unnamed": {
          const { designation } = label;
          if (!label.startedAt) {
            const id = designation ?? s.sid; // no start date (a town hit missing from the index): the SID stands in
            return id ? `${t`Unnamed storm`} · ${id}` : t`Unnamed storm`;
          }
          const month = formatMonth(label.startedAt, lang);
          return designation ? t`Unnamed storm · ${designation} · ${month}` : t`Unnamed storm · ${month}`;
        }
      }
    },
    [t, lang],
  );
}
