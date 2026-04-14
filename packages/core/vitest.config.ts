import { defineConfig } from "vitest/config";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    // Session-manager tests shell out to a mock `opencode` binary; each call uses
    // OPENCODE_DISCOVERY_TIMEOUT_MS (10s) in execFile. Default Vitest 5s is too low
    // when the real CLI is hit or CI is slow — tests would time out before exec does.
    testTimeout: 15_000,
    alias: {
      // Integration tests import real plugins. These aliases resolve
      // package names to source files so we don't need circular devDeps
      // (plugins depend on core, core can't depend on plugins).
      "@aoagents/ao-plugin-tracker-github": resolve(
        __dirname,
        "../plugins/tracker-github/src/index.ts",
      ),
      "@aoagents/ao-plugin-scm-github": resolve(__dirname, "../plugins/scm-github/src/index.ts"),
    },
    coverage: {
      provider: "v8",
      reporter: ["lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/__tests__/**", "src/index.ts", "src/recovery/index.ts"],
    },
  },
});
