import js from "@eslint/js";
import tseslint from "typescript-eslint";

const unusedVars = {
  args: "after-used",
  argsIgnorePattern: "^_",
  varsIgnorePattern: "^_",
  caughtErrorsIgnorePattern: "^_",
  destructuredArrayIgnorePattern: "^_",
  ignoreRestSiblings: true,
};

/**
 * Lint gate for the API (ENR-06). `pnpm lint` fails on errors; warnings are reported and do not
 * fail it.
 *
 * The rules set to "warn" below are the ones the code base already broke when the gate was
 * added. They are debt to pay down file by file, not a statement that the pattern is fine: once
 * a rule has no warnings left, move it back to "error".
 */
export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "scripts/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2023, sourceType: "module" },
    rules: {
      // Used throughout for provider payloads and test doubles.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["warn", unusedVars],
      "@typescript-eslint/ban-ts-comment": "warn",
      "no-useless-escape": "warn",
      "prefer-const": "warn",
      "no-empty": "warn",
      "no-irregular-whitespace": "warn",
    },
  },
  {
    // The LinkedIn enrichment area is clean and stays that way.
    files: ["src/routes/enrichment*.ts", "src/services/enrichment/**/*.ts", "src/workers/enrichment*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", unusedVars],
      "@typescript-eslint/ban-ts-comment": "error",
      "no-useless-escape": "error",
      "prefer-const": "error",
      "no-empty": "error",
      "no-irregular-whitespace": "error",
    },
  }
);
