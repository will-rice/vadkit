// @ts-check
import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import eslintConfigPrettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores(["dist/**", "coverage/**", "models/**", "src/providers/libfvad/fvad.js"]),
  {
    files: ["**/*.{ts,mts,mjs}"],
    extends: [
      js.configs.recommended,
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
      eslintConfigPrettier,
    ],
    languageOptions: {
      parserOptions: {
        // Config files are deliberately outside tsconfig's include.
        projectService: { allowDefaultProject: ["eslint.config.mjs", "commitlint.config.mjs"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The engine serializes provider calls through a promise chain; an
      // un-awaited call is the race that corrupts recurrent state.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      // Sample counts, frame indices, and probabilities belong in error
      // messages; stringifying each one by hand adds noise, not safety.
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
    },
  },
]);
