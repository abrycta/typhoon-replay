// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApiResult } from "@/api";

import { Explorer } from "./Explorer";

// Each call returns a promise the test settles by hand (and that ignores abort), so answers can arrive out of order.
const pending: { url: string; resolve: (r: ApiResult) => void }[] = [];
vi.mock("@/api", () => ({
  sendRequest: (base: string, path: string) =>
    new Promise<ApiResult>((resolve) =>
      pending.push({ url: `${base}${path}`, resolve }),
    ),
}));

i18n.loadAndActivate({ locale: "en", messages: {} });
afterEach(() => {
  cleanup();
  pending.length = 0;
});

const answer = (url: string, from: string): ApiResult => ({
  kind: "ok",
  method: "GET",
  url,
  status: 200,
  ms: 50,
  impl: from,
  body: { from },
});
const labels = {
  java: "Java",
  node: "Node",
  rust: "Rust",
  go: "Go",
} as Parameters<typeof Explorer>[0]["labels"];

function setup() {
  render(
    <I18nProvider i18n={i18n}>
      <Explorer labels={labels} baseUrlOf={(id) => `/api/${id}`} />
    </I18nProvider>,
  );
  const send = () =>
    fireEvent.submit(screen.getByTestId("explore-send").closest("form")!);
  const pick = (id: string) =>
    fireEvent.change(screen.getByLabelText("Backend"), {
      target: { value: id },
    });
  const settle = async (i: number, from: string) =>
    act(async () => pending[i]!.resolve(answer(pending[i]!.url, from)));
  return { send, pick, settle };
}

describe("Explorer: never shows an old response under a new request line", () => {
  it("hides the previous response when the request changes and while a new request is in flight", async () => {
    const { send, pick, settle } = setup();
    send();
    await settle(0, "java");
    expect(screen.getByTestId("explore-body").textContent).toContain(
      '"from": "java"',
    );

    pick("go");
    expect(screen.getByTestId("explore-request").textContent).toBe(
      "GET /api/go/v1/meta",
    );
    expect(screen.queryByTestId("explore-body")).toBeNull();
    expect(screen.getByTestId("explore-status").textContent).toContain(
      "Press Send",
    );

    send();
    expect(screen.queryByTestId("explore-body")).toBeNull();
    expect(screen.getByTestId("explore-status").textContent).toContain(
      "Sending",
    );
    await settle(1, "go");
    expect(screen.getByTestId("explore-body").textContent).toContain(
      '"from": "go"',
    );
  });

  it("ignores an answer that arrives after a newer request started", async () => {
    const { send, pick, settle } = setup();
    send(); // java, slow
    pick("rust");
    send(); // rust, fast
    await settle(1, "rust");
    await settle(0, "java");
    expect(screen.getByTestId("explore-request").textContent).toBe(
      "GET /api/rust/v1/meta",
    );
    expect(screen.getByTestId("explore-body").textContent).toContain(
      '"from": "rust"',
    );
    expect(screen.getByTestId("explore-status").textContent).not.toContain(
      "Sending",
    );
  });
});
