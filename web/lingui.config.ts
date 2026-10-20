import { defineConfig } from "@lingui/cli";
import { formatter } from "@lingui/format-po";

export default defineConfig({
  sourceLocale: "en",
  locales: ["en", "ja"],
  catalogs: [
    {
      path: "<rootDir>/src/shared/i18n/locales/{locale}",
      include: ["<rootDir>/src"],
      exclude: ["**/*.test.*", "**/generated/**"],
    },
  ],
  format: formatter({ lineNumbers: false }),
});
