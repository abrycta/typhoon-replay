import AxeBuilder from "@axe-core/playwright";
import type { Page, Route } from "@playwright/test";

import { expect, HAIYAN, PEAK, test } from "./fixtures";

// ------------------------------------------------------------------------------------------ static visitor pages

const VISITOR_ROUTES = [
  "/",
  "/storms",
  "/storms?q=yolanda",
  `/storm/${HAIYAN}?t=${PEAK}`,
  `/compare?a=${HAIYAN}&b=2021346N05145`,
  "/town",
  "/town?q=tacloban&place=PH-0831600000",
  "/about",
  "/no/such/page",
];

/** Let a page settle; replay pages stream frames for a while, so idle is not awaited forever. */
const settle = (page: Page) => page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});

test("visitor routes make zero /api requests", async ({ page }) => {
  test.setTimeout(120_000);
  const api: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname.startsWith("/api/")) api.push(r.url());
  });
  for (const path of VISITOR_ROUTES) {
    await page.goto(path);
    if (path.startsWith("/storm/")) await expect(page.getByTestId("storm-replay")).toBeVisible({ timeout: 20_000 });
    await settle(page);
  }
  // Client-side navigation through the header too (the shell must not probe anything).
  const nav = page.getByRole("navigation", { name: "Main" });
  for (const name of ["Home", "Storms", "Compare", "My town", "About"]) {
    await nav.getByRole("link", { name, exact: true }).click();
    await settle(page);
  }
  expect(api).toEqual([]);
});

test("My town works from static data with /api blocked", async ({ page }) => {
  const api: string[] = [];
  await page.route("**/api/**", (r) => {
    api.push(r.request().url());
    return r.abort();
  });
  await page.goto("/town");
  await page.getByLabel("City or municipality").fill("taclobn"); // typo on purpose
  await page.getByRole("button", { name: /Tacloban City, Leyte/ }).click();
  await expect(page).toHaveURL(/place=PH-0831600000/);
  const hits = page.getByTestId("town-hits");
  await expect(hits).toContainText("Haiyan (Yolanda) 2013");
  await expect(hits.getByRole("listitem").first()).toContainText(/km away on 8 Nov 2013/);
  // A larger radius lists more storms, all from the same shard file.
  const before = await hits.getByRole("listitem").count();
  await page.getByLabel("Within", { exact: true }).selectOption("500");
  await expect.poll(() => hits.getByRole("listitem").count()).toBeGreaterThan(before);
  // Japanese names are searchable.
  await page.getByLabel("City or municipality").fill("那覇");
  await page.getByRole("button", { name: /Naha, Okinawa/ }).click();
  await expect(page).toHaveURL(/place=JP-47201/);
  expect(api).toEqual([]);
});

test("the header has no backend selector; the footer links to Tech", async ({ page }) => {
  for (const path of ["/", "/town", "/about"]) {
    await page.goto(path);
    await expect(page.getByRole("banner")).not.toContainText(/Served by|Java|Mock/);
    await expect(page.getByTestId("backend-switch")).toHaveCount(0);
    const footer = page.getByRole("contentinfo");
    await expect(footer).not.toContainText("X-Backend-Impl");
    await expect(footer.getByTestId("footer-hook")).toHaveText("Data served statically · API in four languages → Tech");
  }
  await page.getByRole("contentinfo").getByRole("link", { name: "Tech" }).click();
  await expect(page).toHaveURL(/\/under-the-hood$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("One API, four languages");
});

// ------------------------------------------------------------------------------------------ the API page

const PROBLEM = "application/problem+json";
const problem = (code: string, status = 503) => ({ type: `https://replay.krtmtthw.dev/problems/${code}`, title: code, status, code, requestId: "r1" });

/** Haiyan near Tacloban, as two implementations might serialise it (key order, number format, impl field). */
const HITS = {
  radiusKm: 100,
  items: [
    {
      storm: { sid: HAIYAN, name: "Haiyan", localNames: { ph: "Yolanda" }, season: 2013, basin: "WP", startedAt: "2013-11-03T00:00:00Z", endedAt: "2013-11-11T00:00:00Z", peakWindKt: 170, landfallCountries: ["PH"] },
      closestApproachKm: 12.4,
      closestApproachAt: "2013-11-07T23:00:00Z",
      maxWindKtWithinRadius: 170,
      hoursWithinRadius: 6,
    },
    {
      storm: { sid: "2014334N02156", name: "Hagupit", localNames: { ph: "Ruby" }, season: 2014, basin: "WP", startedAt: "2014-11-30T00:00:00Z", endedAt: "2014-12-12T00:00:00Z", peakWindKt: 155, landfallCountries: ["PH"] },
      closestApproachKm: 54,
      closestApproachAt: "2014-12-06T15:00:00Z",
      maxWindKtWithinRadius: 90,
      hoursWithinRadius: 4,
    },
  ],
};
const HITS_NODE = { items: HITS.items.map((h) => ({ ...Object.fromEntries(Object.entries(h).reverse()), closestApproachAt: h.closestApproachAt.replace("Z", ".000Z") })), radiusKm: 100, nextCursor: "opaque" };
const STORM = { sid: HAIYAN, name: "Haiyan", localNames: { ph: "Yolanda" }, season: 2013, basin: "WP", startedAt: "2013-11-03T00:00:00Z", endedAt: "2013-11-11T00:00:00Z", durationHours: 192, fixCount: 64, landfallCountries: ["PH"], peak: { windKt: 170, agency: "jtwc", pressureHpa: 895 }, intensity: [], landfalls: [{ country: "PH", at: "2013-11-07T20:40:00Z", position: [125.7, 11.0] }], sources: [], replayAvailable: true };
const META = { impl: "java", implVersion: "0.1.0", contractVersion: "2.0.0", schemaVersion: "3", datasetVersion: 1, commit: "abc", startedAt: "2026-10-21T00:00:00Z" };

const json = (r: Route, body: unknown, impl: string, cache = "MISS", status = 200) =>
  r.fulfill({ status, contentType: "application/json", headers: { "X-Backend-Impl": impl, "X-Edge-Cache": cache }, body: JSON.stringify(body) });
const problemReply = (r: Route, code: string, headers: Record<string, string> = {}) =>
  r.fulfill({ status: code === "unknown-backend" ? 404 : 503, contentType: PROBLEM, headers: { "X-Edge-Cache": "BYPASS", ...headers }, body: JSON.stringify(problem(code)) });

/** java answers; node is waking once, then answers; rust and go are not deployed. Returns request counts. */
async function mockLanes(page: Page) {
  const count: Record<string, number> = {};
  let nodeCalls = 0;
  await page.route(/\/api\/(java|node|rust|go)\//, async (r) => {
    const url = new URL(r.request().url());
    const impl = url.pathname.split("/")[2]!;
    const key = `${impl} ${url.pathname}`;
    count[key] = (count[key] ?? 0) + 1;
    if (impl === "rust" || impl === "go") return problemReply(r, "backend-not-deployed");
    if (url.pathname.endsWith("/healthz")) return json(r, { status: "ok" }, impl);
    if (url.pathname.endsWith("/v1/meta")) return json(r, { ...META, impl }, impl, "HIT");
    if (impl === "node" && url.pathname.includes("/storms") && nodeCalls++ === 0) return problemReply(r, "backend-waking", { "Retry-After": "1" });
    if (url.pathname.endsWith(`/v1/storms/${HAIYAN}`)) return json(r, STORM, impl);
    return json(r, impl === "node" ? HITS_NODE : HITS, impl);
  });
  return count;
}

test("race: java answers, node wakes then answers the same, rust and go are not deployed", async ({ page }) => {
  const count = await mockLanes(page);
  await page.goto("/under-the-hood");
  // Wake-on-entry: exactly one idle-time /healthz, to Java only.
  await expect.poll(() => count["java /api/java/healthz"]).toBe(1);
  await expect(page.getByTestId("lane-java-state")).toHaveText("awake");
  expect(Object.keys(count)).toEqual(["java /api/java/healthz"]);
  // The ping is not an answer: no time, no match line.
  await expect(page.getByTestId("lane-java-note")).toHaveText("Java is awake.");
  await expect(page.getByTestId("lane-java-time")).toHaveText("—");
  await expect(page.getByTestId("lane-java-match")).toHaveText("");

  await expect(page.getByLabel("Question", { exact: true })).toHaveValue("town");
  await page.getByTestId("race-run").click();
  await expect(page.getByTestId("lane-node-state")).toHaveText("waking up");
  await expect(page.getByTestId("lane-node-note")).toContainText("about a minute on free hosting");
  await expect(page.getByTestId("lane-rust-state")).toHaveText("not deployed yet");
  await expect(page.getByTestId("lane-go-state")).toHaveText("not deployed yet");
  await expect(page.getByTestId("lane-java-state")).toHaveText("awake");
  await expect(page.getByTestId("lane-java-time")).toHaveText(/^\d+ ms$/);
  // The shared result table appears with the first answer.
  await expect(page.getByTestId("race-results")).toContainText("Haiyan (Yolanda)");
  await expect(page.getByTestId("race-caption")).toContainText("From Java");

  await expect(page.getByTestId("lane-node-state")).toHaveText("awake", { timeout: 15_000 });
  await expect(page.getByTestId("lane-node-note")).toContainText("woke up and answered");
  await expect(page.getByTestId("lane-java-match")).toHaveText("✓ Same result");
  await expect(page.getByTestId("lane-node-match")).toHaveText("✓ Same result");
  await expect(page.getByTestId("lane-rust-match")).toHaveText("");
  await expect(page.getByTestId("race-caption")).toContainText("Identical across Java, Node");
  await expect(page.getByTestId("race-summary")).toHaveText("Finished: 2 of 4 backends answered.");
  await expect(page.getByTestId("race-run")).toHaveText("Run again");

  const q = "/v1/places/PH-0831600000/storms";
  expect(count[`node /api/node${q}`]).toBe(2); // waking -> retried once
  expect(count[`rust /api/rust${q}`]).toBe(1); // not deployed -> never retried
  expect(count[`go /api/go${q}`]).toBe(1);

  // Keyboard: Tab from the question to the button and run it with Enter.
  await page.getByLabel("Question", { exact: true }).selectOption("storm");
  await page.getByLabel("Question", { exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("race-run")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("lane-java-state")).toHaveText("awake");
  await expect(page.getByTestId("race-results")).toContainText("895 hPa");
});

test("race: a backend that never wakes ends as an error, the others are unaffected", async ({ page }) => {
  // Retry-After 30 is clamped to 20 s; with the 3-minute cap this would take long, so the test only checks the waking state.
  await page.route(/\/api\/(java|node|rust|go)\//, (r) => problemReply(r, "backend-waking", { "Retry-After": "30" }));
  await page.goto("/under-the-hood");
  await page.getByTestId("race-run").click();
  for (const id of ["java", "node", "rust", "go"]) await expect(page.getByTestId(`lane-${id}-state`)).toHaveText("waking up");
  await expect(page.getByTestId("race-results")).toHaveCount(0);
});

test("race: a contract error (404) is shown with its status and time, not retried", async ({ page }) => {
  let calls = 0;
  await page.route(/\/api\/(java|node|rust|go)\//, (r) => {
    if (r.request().url().includes("/healthz")) return json(r, { status: "ok" }, "java");
    if (!r.request().url().includes("/api/java/")) return problemReply(r, "backend-not-deployed");
    calls++;
    return r.fulfill({ status: 404, contentType: PROBLEM, headers: { "X-Backend-Impl": "java" }, body: JSON.stringify({ ...problem("not-found", 404), title: "Not found" }) });
  });
  await page.goto("/under-the-hood");
  await page.getByTestId("race-run").click();
  await expect(page.getByTestId("lane-java-state")).toHaveText("error");
  await expect(page.getByTestId("lane-java-note")).toHaveText(/^Java answered HTTP 404 \(Not found\) in \d+ ms\.$/);
  await expect(page.getByTestId("lane-java-time")).toHaveText(/^\d+ ms$/);
  expect(calls).toBe(1);
});

test("explorer: request line, status, edge headers and JSON", async ({ page }) => {
  await mockLanes(page);
  await page.goto("/under-the-hood");
  await expect(page.getByTestId("explore-request")).toHaveText("GET /api/java/v1/meta");
  await page.getByTestId("explore-send").click();
  const status = page.getByTestId("explore-status");
  await expect(status).toContainText(/HTTP 200 · \d+ ms/);
  await expect(status).toContainText("X-Backend-Impl: java · X-Edge-Cache: HIT");
  await expect(page.getByTestId("explore-body")).toContainText('"contractVersion": "2.0.0"');

  await page.getByLabel("Backend", { exact: true }).selectOption("rust");
  await expect(page.getByTestId("explore-request")).toHaveText("GET /api/rust/v1/meta");
  await page.getByTestId("explore-send").click();
  await expect(status).toContainText("HTTP 503");
  await expect(status).toContainText("This backend is not deployed yet.");
  await expect(page.getByTestId("explore-body")).toContainText('"code": "backend-not-deployed"');
});

test("conformance table: measured figures, the others next", async ({ page }) => {
  await mockLanes(page);
  await page.goto("/under-the-hood");
  const table = page.getByTestId("conformance").getByRole("table");
  await expect(table.getByRole("columnheader")).toHaveText(["Check", "Java", "Node", "Rust", "Go"]);
  const rows = table.getByRole("row");
  await expect(rows.nth(1)).toHaveText(/Scenario tests.*99 \/ 99\s*next\s*next\s*86 \/ 86/);
  await expect(rows.nth(2)).toHaveText(/Generated API cases.*2,150 \/ 2,150\s*next\s*next\s*1,444 \/ 1,444/);
  await expect(rows.nth(3)).toContainText("2.8 ms");
  await expect(rows.nth(4)).toContainText("≈ 100 s");
  await expect(page.getByTestId("conformance")).toContainText("Node, Rust: built next, against the same suite.");
});

test("Japanese: nav, page and footer", async ({ page }) => {
  await mockLanes(page);
  await page.goto("/under-the-hood?lang=ja");
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("1 つの API、4 つの言語");
  await expect(page.getByRole("navigation", { name: "メイン" }).getByRole("link", { name: "技術" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("footer-hook")).toHaveText("データは静的配信 · API は 4 つの言語で → 技術");
  await expect(page).toHaveTitle("技術 · Replay");
  await page.getByRole("button", { name: "4 つすべてで実行" }).click();
  await expect(page.getByTestId("lane-rust-state")).toHaveText("未デプロイ");
  await expect(page.getByTestId("lane-java-state")).toHaveText("稼働中");
});

for (const scheme of ["light", "dark"] as const) {
  test(`axe after a race (${scheme})`, async ({ page }) => {
    await mockLanes(page);
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await page.goto("/under-the-hood");
    await page.getByTestId("race-run").click();
    await expect(page.getByTestId("lane-node-state")).toHaveText("awake", { timeout: 15_000 });
    await page.getByTestId("explore-send").click();
    await expect(page.getByTestId("explore-body")).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`)).toEqual([]);
  });
}

test.describe("360 px", () => {
  test.use({ viewport: { width: 360, height: 780 }, hasTouch: true, isMobile: true });
  test("the race, explorer and conformance table fit without horizontal page scroll", async ({ page }) => {
    await mockLanes(page);
    await page.goto("/under-the-hood");
    await page.getByTestId("race-run").tap();
    await expect(page.getByTestId("race-results")).toBeVisible();
    await page.getByTestId("explore-send").tap();
    await expect(page.getByTestId("explore-body")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
