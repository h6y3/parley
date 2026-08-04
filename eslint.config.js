import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  {
    // packages/policy/scripts/capture-golden.mjs is a one-shot script (already
    // run once; its output is committed as the golden equivalence fixture) that
    // is not part of any package's tsconfig project, so type-aware lint's
    // projectService can't parse it. Excluded rather than wired into the
    // tsconfig, since it is intentionally not meant to be run again.
    ignores: ["**/dist/**", "**/node_modules/**", "examples/**", "packages/policy/scripts/**"]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    }
  },
  {
    files: ["eslint.config.js", "**/*.config.ts"],
    ...tseslint.configs.disableTypeChecked
  },
  eslintConfigPrettier
);
