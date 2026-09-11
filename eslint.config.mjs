import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import prettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import sonarjs from "eslint-plugin-sonarjs";
import globals from "globals";
import tseslint from "typescript-eslint";

export const qualityLimits = {
  cognitive: 15,
  cyclomatic: 10,
  nesting: 3,
  functionLines: 80,
  parameters: 4,
};
export default defineConfig(
  globalIgnores([
    "node_modules/**",
    "dist/**",
    ".wrangler/**",
    "tmp/**",
    "coverage/**",
    ".claude/**",
    "**/.terraform/**",
  ]),
  {
    files: ["**/*.{ts,tsx,mjs}"],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.strictTypeChecked,
      prettier,
    ],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: {
        project: [
          "./tsconfig.client.json",
          "./tsconfig.server.json",
          "./tsconfig.node.json",
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      sonarjs,
      // Register rules, not the plugin's mixed legacy/flat preset container.
      "react-hooks": { meta: reactHooks.meta, rules: reactHooks.rules },
    },
    rules: {
      curly: ["error", "all"],
      "no-nested-ternary": "error",
      "max-depth": ["error", qualityLimits.nesting],
      complexity: [
        "error",
        { max: qualityLimits.cyclomatic, variant: "modified" },
      ],
      "sonarjs/cognitive-complexity": ["error", qualityLimits.cognitive],
      "sonarjs/no-identical-expressions": "error",
      "sonarjs/no-all-duplicated-branches": "error",
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
      // Resource declarations own disposal even when their handles are unread.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { ignoreUsingDeclarations: true },
      ],
      // Numeric interpolation communicates counts and IDs without noisy casts.
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true },
      ],
    },
    linterOptions: { reportUnusedDisableDirectives: "error" },
  },
  {
    files: ["tests/e2e/fixtures.ts"],
    rules: {
      // Playwright reads fixture dependencies from the first parameter pattern.
      "no-empty-pattern": ["error", { allowObjectPatternsAsParameters: true }],
    },
  },
);
