import { describe, expect, it } from "vitest";

import { makeTyf } from "@/test/tyf-fixture";

import { decoder, frameBounds, maxNear, parseHeader, TyfFormatError, UV_SCALE, windToUv } from "./tyf";

describe("TYF1 format", () => {
  it("parses the header and finds the 8-byte-aligned data offset", () => {
    const { bytes, dataOffset } = makeTyf();
    const parsed = parseHeader(bytes)!;
    expect(parsed.header.frames).toBe(5);
    expect(parsed.dataOffset).toBe(dataOffset);
    expect(parsed.dataOffset % 8).toBe(0);
  });

  it("needs the whole header before parsing and rejects other files", () => {
    const { bytes } = makeTyf();
    expect(parseHeader(bytes.subarray(0, 20))).toBeUndefined();
    expect(() => parseHeader(new TextEncoder().encode("PNG!xxxxxxxx"))).toThrow(TyfFormatError);
  });

  it("decodes linear, sqrt and angle encodings like the pipeline", () => {
    const { header } = makeTyf();
    expect(decoder(header.vars[0]!)(100)).toBeCloseTo(30); // wind 0.3 m/s per step
    expect(decoder(header.vars[2]!)(200)).toBeCloseTo(1000); // mslp 870 + 0.65 q
    expect(decoder(header.vars[3]!)(50)).toBeCloseTo(4); // rain (0.04 q)^2
    expect(decoder(header.vars[4]!)(64)).toBeCloseTo(90); // direction
  });

  it("computes window bounds from cell centres", () => {
    const { header } = makeTyf();
    const b = frameBounds(header, 0);
    expect(b.west).toBeCloseTo(124.875);
    expect(b.east - b.west).toBeCloseTo(header.nx * header.res_deg);
    expect(b.north).toBeCloseTo(12.125);
  });

  it("converts speed + direction (towards) to u/v", () => {
    // wind q=100 (30 m/s) blowing towards the east (q=64 -> 90 deg)
    const { bytes, header, dataOffset, frameBytes } = makeTyf({ fill: (_f, v) => (v === 0 ? 100 : v === 4 ? 64 : 0) });
    const uv = windToUv(bytes.subarray(dataOffset, dataOffset + frameBytes), header);
    expect((uv[0]! - 128) * UV_SCALE).toBeCloseTo(30, 0);
    expect((uv[1]! - 128) * UV_SCALE).toBeCloseTo(0, 0);
  });

  it("finds the field maximum near a centre and skips nodata", () => {
    const { bytes, header, dataOffset, frameBytes } = makeTyf({ fill: (_f, v, k) => (v === 0 ? (k === 5 ? 90 : k === 6 ? 255 : 10) : 0) });
    const frame = bytes.subarray(dataOffset, dataOffset + frameBytes);
    expect(maxNear(frame, header, 0, "wind", 125.25, 11.75, 2)).toBeCloseTo(27);
    expect(maxNear(frame, header, 0, "missing", 125, 12, 2)).toBeUndefined();
  });
});
