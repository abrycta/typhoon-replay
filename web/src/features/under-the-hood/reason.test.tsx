// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { messages as ja } from "@/shared/i18n/locales/ja.po";

import { useReasonText } from "./reason";

const wrapper = ({ children }: { children: ReactNode }) => <I18nProvider i18n={i18n}>{children}</I18nProvider>;
const reasonIn = (locale: "en" | "ja") => {
  i18n.loadAndActivate({ locale, messages: locale === "ja" ? (ja as never) : {} });
  return renderHook(() => useReasonText(), { wrapper }).result.current;
};

// Every reason a lane can carry: wake.ts, request.ts, the contract's and the edge's problem titles,
// browser network messages and a title the page has never seen.
const CASES: [string, number | undefined][] = [
  ["did not wake up in time", 503],
  ["not deployed", 503],
  ["paused this month", 503],
  ["rate limited", 429],
  ["network error", 0],
  ["invalid JSON", 200],
  ["Request validation failed", 400],
  ["Invalid cursor", 400],
  ["Not found", 404],
  ["Unknown backend", 404],
  ["Method not allowed", 405],
  ["Not acceptable", 406],
  ["Payload too large", 413],
  ["Unsupported media type", 415],
  ["Too many requests", 429],
  ["Internal server error", 500],
  ["Service not ready", 503],
  ["Too many live streams", 503],
  ["Backend not deployed", 503],
  ["Backend is waking up", 503],
  ["Backend unavailable", 503],
  ["Backend paused this month", 503],
  ["Bad gateway", 502],
  ["Gateway timeout", 504],
  ["API in static mode", 503],
  ["HTTP 502", 502],
  ["Failed to fetch", 0],
  ["Load failed", 0],
  ["signal timed out", 0],
  ["Something unexpected broke", 500],
  ["Teapot", 418],
];

/** Latin words a Japanese note may keep: protocol names, units and nothing else. */
const strayEnglish = (s: string) => s.replace(/\b(HTTP|JSON|API)\b/g, "").match(/[A-Za-z]{2,}/g);

describe("race lane reasons", () => {
  it("are Japanese in Japanese notes, with no stray English", () => {
    const reason = reasonIn("ja");
    for (const [r, status] of CASES) expect(strayEnglish(reason(r, status)), `${r} → ${reason(r, status)}`).toBeNull();
    expect(reason("Not found", 404)).toBe("見つかりません");
    expect(reason("signal timed out", 0)).toBe("タイムアウト");
    expect(reason("Failed to fetch", 0)).toBe("ネットワークエラー");
  });

  it("keep the server's own words in English", () => {
    const reason = reasonIn("en");
    expect(reason("Not found", 404)).toBe("Not found");
    expect(reason("Something unexpected broke", 500)).toBe("Something unexpected broke");
    expect(reason("Failed to fetch", 0)).toBe("Failed to fetch");
    expect(reason(undefined)).toBe("?");
  });
});
