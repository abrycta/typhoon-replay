import { describe, expect, it } from "vitest";

import { fileFetch, makeTyf } from "@/test/tyf-fixture";

import { type DecodedFrames, FrameLoadError, TyfLoader, windowOrder } from "./loader";

function collect() {
  const batches: DecodedFrames[] = [];
  const got = new Map<number, Uint8Array>();
  const sink = {
    strategy: "",
    header: (_h: unknown, s: string) => void (sink.strategy = s),
    frames: (b: DecodedFrames) => {
      batches.push(b);
      const fb = b.raw.length / b.count;
      for (let i = 0; i < b.count; i++) got.set(b.start + i, b.raw.slice(i * fb, (i + 1) * fb));
    },
  };
  return { sink, batches, got };
}

describe("TyfLoader", () => {
  const file = makeTyf({ frames: 30, nx: 8, ny: 6 });
  const expectFrames = (got: Map<number, Uint8Array>) => {
    expect(got.size).toBe(30);
    for (let i = 0; i < 30; i++) {
      const want = file.bytes.subarray(file.dataOffset + i * file.frameBytes, file.dataOffset + (i + 1) * file.frameBytes);
      expect(got.get(i)).toEqual(want);
    }
  };

  it("uses range windows when the host answers 206, nearest the playhead first", async () => {
    const { fetch, calls } = fileFetch(file.bytes);
    const { sink, got } = collect();
    const loader = new TyfLoader("x.tyf", sink, { fetch, focus: 20, windowFrames: 8, concurrency: 1, probeBytes: 4096 });
    expect(await loader.run()).toBe("range");
    expect(sink.strategy).toBe("range");
    expectFrames(got);
    // first window after the probe is the one holding frame 20 (frames 16-23)
    const first = calls[1]!;
    const from = Number(/bytes=(\d+)/.exec(first)![1]);
    expect(Math.floor((from - file.dataOffset) / file.frameBytes)).toBe(16);
  });

  it("streams the same response frame by frame when the host ignores Range (200)", async () => {
    const { fetch, calls } = fileFetch(file.bytes, { ranges: false, chunk: 50 });
    const { sink, got, batches } = collect();
    expect(await new TyfLoader("x.tyf", sink, { fetch }).run()).toBe("stream");
    expect(calls).toHaveLength(1); // one request, no refetch
    expect(batches.length).toBeGreaterThan(5); // emitted progressively
    expectFrames(got);
  });

  it("streams gzip through DecompressionStream", async () => {
    const gz = new Uint8Array(await new Response(new Blob([file.bytes]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
    const { fetch } = fileFetch(gz, { ranges: false });
    const { sink, got } = collect();
    expect(await new TyfLoader("x.tyf.gz", sink, { fetch, format: "tyf.gz" }).run()).toBe("stream");
    expectFrames(got);
  });

  it("reports truncated files and HTTP errors", async () => {
    const { fetch } = fileFetch(file.bytes.subarray(0, file.dataOffset + 3 * file.frameBytes + 10), { ranges: false });
    await expect(new TyfLoader("x.tyf", collect().sink, { fetch }).run()).rejects.toThrow(/truncated/);
    const notFound = (async () => new Response("no", { status: 404 })) as typeof globalThis.fetch;
    await expect(new TyfLoader("x.tyf", collect().sink, { fetch: notFound }).run()).rejects.toBeInstanceOf(FrameLoadError);
  });

  it("orders windows outward from the focus, forward first", () => {
    expect(windowOrder(100, 10, 45, () => false)).toEqual([4, 5, 3, 6, 2, 7, 1, 8, 0, 9]);
    expect(windowOrder(100, 10, 45, (w) => w === 4)).toEqual([5, 3, 6, 2, 7, 1, 8, 0, 9]);
  });
});
