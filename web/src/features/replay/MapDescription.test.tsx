// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { messages as en } from "@/shared/i18n/locales/en.po";
import { messages as ja } from "@/shared/i18n/locales/ja.po";

import { MapDescription, MapUnavailableText } from "./MapDescription";

afterEach(cleanup);

function text(locale: "en" | "ja", tableShown: boolean) {
  i18n.loadAndActivate({
    locale,
    messages: (locale === "en" ? en : ja) as never,
  });
  const { container } = render(
    <I18nProvider i18n={i18n}>
      <MapDescription id="d" tableShown={tableShown} />
      <span>
        <MapUnavailableText tableShown={tableShown} />
      </span>
    </I18nProvider>,
  );
  const out = {
    desc: container.querySelector("#d")!.textContent!,
    alert: container.querySelector("span")!.textContent!,
  };
  cleanup();
  return out;
}

describe("map description matches what the view shows", () => {
  it("mentions the timeline table only when it is on the page (EN)", () => {
    expect(text("en", true).desc).toContain("timeline table below");
    expect(text("en", true).alert).toContain("timeline table");
    expect(text("en", false).desc).not.toMatch(/table/i);
    expect(text("en", false).alert).not.toMatch(/table/i);
    expect(text("en", false).desc).toContain("The map shows");
  });

  it("mentions the timeline table only when it is on the page (JA)", () => {
    expect(text("ja", true).desc).toContain("タイムライン表");
    expect(text("ja", true).alert).toContain("タイムライン表");
    expect(text("ja", false).desc).not.toContain("タイムライン");
    expect(text("ja", false).alert).not.toContain("タイムライン");
    expect(text("ja", false).desc).toContain("地図には");
  });
});
