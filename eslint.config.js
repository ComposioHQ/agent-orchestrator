import eslint from "@eslint/js";
import { FlatCompat } from "@eslint/eslintrc";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

const compat = new FlatCompat({
  baseDirectory: import.meta.dirname,
  recommendedConfig: eslint.configs.recommended,
});

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.next/**",
      "**/coverage/**",
      "packages/web/next-env.d.ts",
      "packages/web/next.config.js",
      "packages/web/postcss.config.mjs",
      "test-clipboard*.mjs",
      "test-clipboard*.sh",
      "packages/mobile/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strict,
  ...compat.config({
    extends: ["next/core-web-vitals"],
    settings: {
      next: {
        rootDir: "packages/web",
      },
    },
    rules: {
      "@next/next/no-html-link-for-pages": "off",
    },
  }),
  eslintConfigPrettier,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-console": "warn",
      "no-debugger": "error",
      "no-duplicate-imports": "error",
      "no-template-curly-in-string": "warn",
      "prefer-const": "error",
      "no-var": "error",
      eqeqeq: ["error", "always"],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "@typescript-eslint/no-non-null-assertion": "warn",
      "@typescript-eslint/no-require-imports": "error",
    },
  },
  {
    files: ["**/*.test.ts", "**/__tests__/**"],
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  {
    files: ["packages/cli/**/*.ts"],
    rules: {
      "no-console": "off",
    },
  },
  {
    files: ["packages/web/**/*.tsx", "packages/web/**/*.ts"],
    rules: {
      "no-console": "off",
    },
  },

  {
    files: ["packages/web/src/app/dev/**/*.tsx", "packages/web/src/app/test-direct/**/*.tsx"],
    rules: {
      "react/no-unescaped-entities": "off",
    },
  },

  {
    files: ["scripts/**/*.js", "scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
      },
    },
    rules: {
      "no-console": "off",
    },
  },
);
