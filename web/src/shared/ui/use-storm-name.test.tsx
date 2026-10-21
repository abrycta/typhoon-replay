// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { useStormName } from "./use-storm-name";

i18n.loadAndActivate({ locale: "en", messages: {} });
const wrapper = ({ children }: { children: ReactNode }) => <I18nProvider i18n={i18n}>{children}</I18nProvider>;
const name = renderHook(() => useStormName(), { wrapper }).result.current;
const at = "1940-02-01T00:00:00Z";

describe("useStormName (plain-text names for titles, pickers and links)", () => {
  it("never shows a bare Unnamed", () => {
    expect(name({ name: "Haiyan", localNames: { ph: "Yolanda" }, startedAt: at })).toBe("Haiyan (Yolanda)");
    expect(name({ name: "Unnamed", localNames: { ph: "Crising" }, startedAt: at })).toBe("Crising (PAGASA name)");
    expect(name({ name: "Unnamed", localNames: { ja: "台風第7号" }, startedAt: at })).toBe("Typhoon No. 7 (JMA number)");
    expect(name({ name: "Unnamed", designation: "03W", startedAt: at })).toMatch(/^Unnamed storm · 03W · /);
    // A town hit whose storm is not in the index: no start date, so the SID stands in.
    expect(name({ sid: "1940032N08122", name: "" })).toBe("Unnamed storm · 1940032N08122");
  });
});
