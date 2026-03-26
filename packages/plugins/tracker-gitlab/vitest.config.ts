import { defineConfig } from "vitest/config";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@composio/ao-plugin-scm-gitlab/glab-utils": resolve(
        __dirname,
        "../scm-gitlab/src/glab-utils.ts",
      ),
    },
  },
});
