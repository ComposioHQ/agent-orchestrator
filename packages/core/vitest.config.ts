import { defineConfig } from "vitest/config";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    alias: {
      // Integration tests import real plugins. These aliases resolve
      // package names to source files so we don't need circular devDeps
      // (plugins depend on core, core can't depend on plugins).
      "@composio/ao-plugin-tracker-github": resolve(
        __dirname,
        "../plugins/tracker-github/src/index.ts",
      ),
      "@composio/ao-plugin-scm-github": resolve(__dirname, "../plugins/scm-github/src/index.ts"),
      // The plugins above import from @composio/ao-core. Alias sub-path
      // exports to source so the tests work without a pre-built dist.
      "@composio/ao-core/scm-webhook-utils": resolve(__dirname, "src/scm-webhook-utils.ts"),
      "@composio/ao-core": resolve(__dirname, "src/index.ts"),
    },
  },
});
