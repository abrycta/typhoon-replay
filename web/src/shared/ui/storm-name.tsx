import { useLang } from "@abrycta/akari/react";
import { useLingui } from "@lingui/react/macro";

import { stormLabel } from "../lib/names";
import { type NamedStorm, useStormName } from "./use-storm-name";

/**
 * The storm's name as a heading: the international name with the PAGASA name muted beside it, else a local
 * name marked as such, else an honest description ("Unnamed storm · 03W · Feb 1940").
 */
export function StormName({ s }: { s: NamedStorm }) {
  const { t } = useLingui();
  const { lang } = useLang();
  const name = useStormName();
  const label = stormLabel({ ...s, startedAt: s.startedAt ?? "" });
  const note = "font-normal text-sm text-muted-foreground";
  const gap = lang === "ja" ? "" : " ";
  switch (label.kind) {
    case "international":
      return (
        <>
          {label.name}
          {s.localNames?.ph ? <span className="font-normal text-muted-foreground"> ({s.localNames.ph})</span> : null}
        </>
      );
    case "pagasa":
      return (
        <>
          {label.name}
          <span className={note}>
            {gap}
            {t`(PAGASA name)`}
          </span>
        </>
      );
    case "jma": {
      const { number } = label;
      return (
        <>
          {lang === "ja" ? <span lang="ja">{label.ja}</span> : t`Typhoon No. ${number}`}
          <span className={note}>
            {gap}
            {t`(JMA number)`}
          </span>
        </>
      );
    }
    case "unnamed":
      return <>{name(s)}</>;
  }
}
