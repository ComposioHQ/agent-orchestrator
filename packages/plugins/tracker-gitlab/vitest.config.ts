import { mergeConfig, defineConfig } from "vitest/config";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharedConfig from "../vitest.config.shared.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default mergeConfig(sharedConfig, defineConfig({
  test: {
    alias: {
      "@composio/ao-plugin-scm-gitlab/glab-utils": resolve(
        __dirname,
        "../scm-gitlab/src/glab-utils.ts",
      ),
    },
  },
}));
