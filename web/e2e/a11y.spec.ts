import AxeBuilder from "@axe-core/playwright";

import { expect, HAIYAN, PEAK, test, waitForReplay } from "./fixtures";

const THEMES = [
  { name: "light", scheme: "light" as const, contrast: "no-preference" as const },
  { name: "dark", scheme: "dark" as const, contrast: "no-preference" as const },
  { name: "high-contrast", scheme: "light" as const, contrast: "more" as const },
  { name: "dark high-contrast", scheme: "dark" as const, contrast: "more" as const },
];
const PAGES = [
  { name: "home", path: "/" },
  { name: "storm", path: `/storm/${HAIYAN}?t=${PEAK}` },
  { name: "storms", path: "/storms" },
  { name: "compare", path: `/compare?a=${HAIYAN}&b=2021346N05145` },
  { name: "town", path: "/town?backend=mock&q=tacloban&place=PH-0831600000" },
  { name: "about", path: "/about" },
];

for (const theme of THEMES) {
  for (const p of PAGES) {
    test(`axe: ${p.name} in ${theme.name}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme.scheme, contrast: theme.contrast, reducedMotion: "reduce" });
      await page.goto(p.path);
      if (p.name === "storm") await waitForReplay(page);
      else await page.waitForLoadState("networkidle");
      if (theme.contrast === "more") await expect(page.locator("html")).not.toHaveAttribute("data-contrast", "normal");
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        // MapLibre's own canvas/controls are third-party; everything around them is checked.
        .exclude(".maplibregl-ctrl-attrib")
        .analyze();
      const summary = results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`);
      expect(summary).toEqual([]);
    });
  }
}
