// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { interpolateHourly } from "@/data";

import { TimelineTable } from "./TimelineTable";

i18n.loadAndActivate({ locale: "en", messages: {} });
afterEach(cleanup);

const hours = interpolateHourly([
  { t: "2013-11-07T00:00:00Z", lon: 130, lat: 10, jtwcKt: 160, jmaKt: 120, jmaHpa: 900 },
  { t: "2013-11-07T03:00:00Z", lon: 128, lat: 10.5, jtwcKt: 170, jmaKt: 125, jmaHpa: 895 },
]);
const times = hours.map((h) => h.t);

describe("TimelineTable (text alternative to the map)", () => {
  it("lists every hour with provenance and jumps the replay on click", () => {
    const onJump = vi.fn();
    render(
      <I18nProvider i18n={i18n}>
        <TimelineTable times={times} hours={hours} era5={(i) => (i === 0 ? 27 : undefined)} current={1} onJump={onJump} units="kt" lang="en" tz="UTC" />
      </I18nProvider>,
    );
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(4);
    expect(within(rows[0]!).getByText("observed")).toBeTruthy();
    expect(within(rows[1]!).getByText(/interpolated/)).toBeTruthy();
    expect(rows[1]!.getAttribute("aria-current")).toBe("true");
    fireEvent.click(within(rows[2]!).getByRole("button"));
    expect(onJump).toHaveBeenCalledWith(2);
  });

  it("keeps every landfall on its own hour row, even when several fall on one day", () => {
    const track = interpolateHourly([
      { t: "2021-12-16T00:00:00Z", lon: 127, lat: 10, jtwcKt: 140 },
      { t: "2021-12-17T06:00:00Z", lon: 118, lat: 10, jtwcKt: 100 },
    ]);
    const ts = track.map((h) => h.t);
    const eight = ["05:30", "08:00", "10:00", "12:00", "13:30", "17:00", "20:00"].map((hm) => ({ country: "PH" as const, at: `2021-12-16T${hm}:00Z` }));
    eight.push({ country: "PH", at: "2021-12-17T01:00:00Z" });
    render(
      <I18nProvider i18n={i18n}>
        <TimelineTable times={ts} hours={track} era5={() => undefined} current={0} onJump={() => {}} units="kt" lang="en" tz="UTC" landfalls={eight} />
      </I18nProvider>,
    );
    const marks = screen.getAllByTestId("timeline-landfall").map((e) => e.textContent);
    expect(marks).toHaveLength(8);
    expect(marks[0]).toBe("Landfall in the Philippines at 16 Dec, 05:30");
    expect(marks[7]).toBe("Landfall in the Philippines at 17 Dec, 01:00");
    // The landfall rows stay listed with "observed fixes only".
    fireEvent.click(screen.getByRole("switch"));
    expect(screen.getAllByTestId("timeline-landfall")).toHaveLength(8);
  });

  it("can show observed fixes only", () => {
    render(
      <I18nProvider i18n={i18n}>
        <TimelineTable times={times} hours={hours} era5={() => undefined} current={0} onJump={() => {}} units="ms" lang="en" tz="UTC" />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole("switch"));
    expect(screen.getAllByRole("row").slice(1)).toHaveLength(2);
  });
});
