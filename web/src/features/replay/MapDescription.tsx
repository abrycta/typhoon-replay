import { useLingui } from "@lingui/react/macro";

/**
 * The map's screen-reader description (the canvas's aria-describedby). It mentions the timeline table only when the
 * table is on the page: the compact view and the frozen embeds hide it.
 */
export function MapDescription({ id, tableShown }: { id: string; tableShown: boolean }) {
  const { t } = useLingui();
  return (
    <p id={id} className="sr-only">
      {tableShown
        ? t`The map shows the storm-following ERA5 field window, the best track as a line with observed fixes as dots, and the current centre as a ring (filled at observed fixes, hollow when interpolated). The timeline table below has the same data as text.`
        : t`The map shows the storm-following ERA5 field window, the best track as a line with observed fixes as dots, and the current centre as a ring (filled at observed fixes, hollow when interpolated).`}
    </p>
  );
}

/** The "Map unavailable" text: it points to the timeline table only when the table is on the page. */
export function MapUnavailableText({ tableShown }: { tableShown: boolean }) {
  const { t } = useLingui();
  return tableShown
    ? t`This browser cannot draw the WebGL map, so the track is shown as a simple drawing. The timeline table has all the data.`
    : t`This browser cannot draw the WebGL map, so the track is shown as a simple drawing.`;
}
