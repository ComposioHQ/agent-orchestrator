/**
 * Shared vitest configuration for all @composio/ao plugins.
 *
 * Aliases @composio/ao-core (and its sub-path exports) to source files so
 * tests run without requiring a pre-built dist of ao-core.
 */
import { defineConfig } from "vitest/config";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const coreDir = resolve(__dirname, "../core/src");

export default defineConfig({
  test: {
    alias: {
      "@composio/ao-core/scm-webhook-utils": resolve(coreDir, "scm-webhook-utils.ts"),
      "@composio/ao-core/utils": resolve(coreDir, "utils.ts"),
      "@composio/ao-core/types": resolve(coreDir, "types.ts"),
      "@composio/ao-core": resolve(coreDir, "index.ts"),
    },
  },
});
