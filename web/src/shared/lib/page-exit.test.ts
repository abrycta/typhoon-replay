// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveDataset } from "@/data/dataset";

import { isLeavingPage, onPageExit, STAY_MS } from "./page-exit";

const cfg = { baseUrl: "https://hf.example/", pointer: "latest.json", fallbackBaseUrls: ["/fixtures/"] };

afterEach(() => {
  window.dispatchEvent(new Event("pageshow"));
  vi.useRealTimers();
});

describe("leaving the page mid-load", () => {
  it("the dataset does not ask the fallback host for a request the browser cancelled", async () => {
    const asked: string[] = [];
    const f = (async (input: RequestInfo | URL) => {
      asked.push(String(input));
      throw new TypeError("Load failed"); // what a cancelled request looks like
    }) as typeof fetch;
    window.dispatchEvent(new Event("beforeunload"));
    expect(isLeavingPage()).toBe(true);
    await expect(resolveDataset(cfg, f)).rejects.toThrow(/No dataset reachable/);
    expect(asked).toEqual(["https://hf.example/latest.json"]);
  });

  it("falls back as before when the reader stays (or comes back from the back/forward cache)", async () => {
    vi.useFakeTimers();
    const seen: boolean[] = [];
    const off = onPageExit((v) => seen.push(v));
    window.dispatchEvent(new Event("beforeunload"));
    vi.advanceTimersByTime(STAY_MS + 1);
    expect(isLeavingPage()).toBe(false);
    window.dispatchEvent(new Event("beforeunload"));
    window.dispatchEvent(new Event("pageshow"));
    expect(isLeavingPage()).toBe(false);
    expect(seen).toEqual([true, false, true, false]);
    off();
    vi.useRealTimers();
    const f = (async (input: RequestInfo | URL) =>
      String(input).startsWith("/fixtures/") ? new Response(JSON.stringify({ version: 1 }), { headers: { "Content-Type": "application/json" } }) : Promise.reject(new TypeError("Load failed"))) as typeof fetch;
    expect((await resolveDataset(cfg, f)).source).toBe("fallback");
  });
});
