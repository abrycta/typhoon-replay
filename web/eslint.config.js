import js from "@eslint/js";
import boundaries from "eslint-plugin-boundaries";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

// Architecture rules (web/docs/ARCHITECTURE-RESEARCH.md §2), readable by a reviewer:
//   - only src/api talks to a backend, and only the under-the-hood feature may import it (through "@/api"):
//     every visitor page (home, storms, storm, compare, town, about) runs from static files;
//   - src/data (static frames, tracks, index, places) never imports src/api: the site works with every backend asleep;
//   - features never import each other; routes compose them; app and routes never import src/api.
const API_FEATURES = ["under-the-hood"];

export default tseslint.config(
  { ignores: ["dist", ".wrangler", "node_modules", "src/routeTree.gen.ts", "src/api/generated", "public/mockServiceWorker.js", "test-results", "playwright-report"] },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: { ecmaVersion: 2023, globals: globals.browser },
    plugins: { "react-hooks": reactHooks, "react-refresh": reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true, allowExportNames: ["Route"] }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { boundaries },
    settings: {
      "import/resolver": { typescript: { project: "./tsconfig.app.json" } },
      "boundaries/elements": [
        { type: "app", pattern: "src/app" },
        { type: "routes", pattern: "src/routes" },
        { type: "feature", pattern: "src/features/*", capture: ["name"] },
        { type: "api", pattern: "src/api" },
        { type: "data", pattern: "src/data" },
        { type: "shared", pattern: "src/shared" },
        { type: "test", pattern: "src/test" },
      ],
      "boundaries/include": ["src/**/*"],
      // Entry point and the generated route tree sit above every layer.
      "boundaries/ignore": ["src/main.tsx", "src/routeTree.gen.ts"],
    },
    rules: {
      "boundaries/dependencies": [
        2,
        {
          default: "disallow",
          policies: [
            { from: { element: { type: "app" } }, allow: { to: { element: { types: { anyOf: ["app", "routes", "feature", "data", "shared"] } } } } },
            { from: { element: { type: "routes" } }, allow: { to: { element: { types: { anyOf: ["app", "routes", "feature", "data", "shared"] } } } } },
            { from: { element: { type: "feature" } }, allow: { to: { element: { types: { anyOf: ["data", "shared"] } } } } },
            { from: { element: { type: "feature", captured: { name: API_FEATURES } } }, allow: { to: { element: { type: "api" } } } },
            { from: { element: { type: "api" } }, allow: { to: { element: { types: { anyOf: ["api", "shared"] } } } } },
            { from: { element: { type: "data" } }, allow: { to: { element: { types: { anyOf: ["data", "shared"] } } } } },
            { from: { element: { type: "shared" } }, allow: { to: { element: { type: "shared" } } } },
            { from: { element: { type: "test" } }, allow: { to: { element: { types: { anyOf: ["api", "data", "shared", "test"] } } } } },
          ],
        },
      ],
    },
  },
  {
    // Tests may reach shared test helpers from any layer; Playwright's `use` is not a React hook.
    files: ["src/**/*.test.{ts,tsx}"],
    rules: { "boundaries/dependencies": "off" },
  },
  {
    files: ["e2e/**/*.ts"],
    rules: { "react-hooks/rules-of-hooks": "off" },
  },
  {
    // TanStack Router's Vite plugin handles HMR for route files (they export `Route`, not components).
    files: ["src/routes/**/*.tsx"],
    rules: { "react-refresh/only-export-components": "off" },
  },
  {
    // Outside src/api: no HTTP client, no mocks, no deep imports into the API layer.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/api/**", "src/**/*.test.{ts,tsx}", "src/test/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "openapi-fetch", message: "Only src/api talks to a backend." },
            { name: "openapi-msw", message: "Mocks live in src/api/mocks." },
            { name: "msw", message: "Mocks live in src/api/mocks." },
          ],
          patterns: [
            { group: ["@/api/*", "**/api/*"], message: 'Import the API layer through its public index: "@/api".' },
            { group: ["msw/*"], message: "Mocks live in src/api/mocks." },
          ],
        },
      ],
    },
  },
  {
    // Raw network access only in the API layer (backends) and the data layer (static files).
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/api/**", "src/data/**", "src/shared/config/**", "src/**/*.test.{ts,tsx}", "src/test/**"],
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "fetch", message: "Fetch through src/api (backends) or src/data (static files)." },
        { name: "EventSource", message: "SSE goes through src/api." },
      ],
    },
  },
  {
    files: ["scripts/**/*.{js,mjs,ts}", "e2e/**/*.ts", "*.config.{js,ts}"],
    languageOptions: { globals: globals.node },
  },
);
