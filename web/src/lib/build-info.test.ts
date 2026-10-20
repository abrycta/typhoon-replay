import { describe, expect, it } from "vitest";

import { formatBuildInfo } from "./build-info";

describe("formatBuildInfo", () => {
  it("shortens the SHA and formats the time in UTC", () => {
    expect(
      formatBuildInfo({
        commit: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
        builtAt: "2026-10-20T14:05:09.123Z",
      }),
    ).toBe("build 1a2b3c4 · 2026-10-20 14:05 UTC");
  });

  it("passes through placeholders", () => {
    expect(formatBuildInfo({ commit: "unknown", builtAt: "n/a" })).toBe("build unknown · n/a");
  });
});
