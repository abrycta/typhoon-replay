import { Badge, useLang } from "@abrycta/akari/react";
import { useLingui } from "@lingui/react/macro";

import { useManifest } from "@/data";
import { formatDate } from "@/shared/lib/time";

/** "Data as of <date>" plus attribution, from the dataset manifest. */
export function DataAsOf() {
  const { t } = useLingui();
  const { lang } = useLang();
  const q = useManifest();
  if (!q.data || !q.dataset) return q.error ? <span>{t`Dataset unavailable`}</span> : null;
  const m = q.data;
  const ds = { data: q.dataset };
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1" data-testid="data-as-of">
      <span>
        {t`Data v${ds.data.version}`}
        {m.dataAsOf ? ` · ${t`as of ${formatDate(m.dataAsOf, lang)}`}` : ""}
      </span>
      {ds.data.source === "fallback" || m.fixture ? (
        <Badge variant="outline" title={ds.data.primaryError}>
          {t`sample data`}
        </Badge>
      ) : null}
    </span>
  );
}

export function Attribution() {
  const sources = useManifest().data?.sources ?? [];
  if (!sources.length) return null;
  return <span>{sources.map((s) => s.attribution ?? s.name).join(" · ")}</span>;
}

export function SourcesList() {
  const { t } = useLingui();
  const sources = useManifest().data?.sources ?? [];
  if (!sources.length) return <p className="text-sm text-muted-foreground">{t`Loading sources…`}</p>;
  return (
    <ul className="grid gap-2 text-sm">
      {sources.map((s) => (
        <li key={s.id}>
          <a href={s.url} className="font-semibold text-ak-text-link underline-offset-4 hover:underline" rel="noreferrer">
            {s.name}
          </a>
          {s.license ? <span className="text-muted-foreground"> · {s.license}</span> : null}
          {s.attribution ? <span className="block text-muted-foreground">{s.attribution}</span> : null}
        </li>
      ))}
    </ul>
  );
}
