import { describe, expect, it } from "vitest";

import { isUnnamed, jmaNumber, stormLabel, stormTitle } from "./names";
import { formatMonth } from "./time";

const at = "1940-02-01T00:00:00Z";

describe("stormLabel", () => {
  it("uses the international name when there is one", () => {
    expect(stormLabel({ name: "Haiyan", localNames: { ph: "Yolanda" }, startedAt: at })).toEqual({ kind: "international", name: "Haiyan" });
  });

  it("prefers a PAGASA name, then a JMA number, for storms without an international name", () => {
    expect(stormLabel({ name: "Unnamed", localNames: { ph: "Crising", ja: "台風第3号" }, designation: "03W", startedAt: at })).toEqual({
      kind: "pagasa",
      name: "Crising",
      designation: "03W",
    });
    expect(stormLabel({ name: "Unnamed", localNames: { ja: "台風第7号" }, startedAt: at })).toEqual({ kind: "jma", number: 7, ja: "台風第7号", designation: undefined });
  });

  it("describes storms with no name at all by their start month (and designation when the index has one)", () => {
    expect(stormLabel({ name: "Unnamed", localNames: {}, startedAt: at })).toEqual({ kind: "unnamed", startedAt: at, designation: undefined });
    expect(stormLabel({ name: "NOT_NAMED", designation: " 26W ", startedAt: at })).toMatchObject({ kind: "unnamed", designation: "26W" });
    // A Japanese name without a number is not a JMA designation.
    expect(stormLabel({ name: "Unnamed", localNames: { ja: "台風" }, startedAt: at }).kind).toBe("unnamed");
  });

  it("works with the current index (no designation field)", () => {
    const fromV1 = JSON.parse('{"sid":"1940032N08122","name":"Unnamed","localNames":{},"season":1940,"startedAt":"1940-02-01T00:00:00Z"}');
    expect(stormLabel(fromV1)).toEqual({ kind: "unnamed", startedAt: at, designation: undefined });
  });
});

describe("name helpers", () => {
  it("recognises IBTrACS's unnamed spellings", () => {
    expect(["Unnamed", "NOT_NAMED", "UNNAMED", "", " "].every(isUnnamed)).toBe(true);
    expect(isUnnamed("Nameless")).toBe(false);
  });

  it("reads the JMA number from a Japanese designation", () => {
    expect(jmaNumber("台風第7号")).toBe(7);
    expect(jmaNumber("伊勢湾台風（昭和34年台風第15号）")).toBe(15);
    expect(jmaNumber("狩野川台風")).toBeUndefined();
    expect(jmaNumber(undefined)).toBeUndefined();
  });

  it("formats the start month per language", () => {
    expect(formatMonth(at, "en")).toBe("Feb 1940");
    expect(formatMonth(at, "ja")).toBe("1940年2月");
  });

  it("keeps the existing title rule for named storms", () => {
    expect(stormTitle({ name: "Haiyan", localNames: { ph: "Yolanda", ja: "台風第30号" } }, "ja")).toBe("Haiyan (Yolanda) · 台風第30号");
  });
});
