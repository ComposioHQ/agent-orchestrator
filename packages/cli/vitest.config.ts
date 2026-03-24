import { defineConfig } from "vitest/config";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const coreDir = resolve(__dirname, "../core/src");
const pluginsDir = resolve(__dirname, "../plugins");

export default defineConfig({
  test: {
    include: ["__tests__/**/*.test.ts"],
    testTimeout: 10000,
    pool: "threads",
    poolOptions: {
      threads: {
        minThreads: 1,
        maxThreads: 8,
      },
    },
    alias: {
      // Resolve @composio/ao-core and its sub-path exports from source so
      // tests run without requiring a pre-built dist.
      "@composio/ao-core/scm-webhook-utils": resolve(coreDir, "scm-webhook-utils.ts"),
      "@composio/ao-core/utils": resolve(coreDir, "utils.ts"),
      "@composio/ao-core/types": resolve(coreDir, "types.ts"),
      "@composio/ao-core": resolve(coreDir, "index.ts"),
      // Plugin aliases
      "@composio/ao-plugin-agent-aider": resolve(pluginsDir, "agent-aider/src/index.ts"),
      "@composio/ao-plugin-agent-claude-code": resolve(pluginsDir, "agent-claude-code/src/index.ts"),
      "@composio/ao-plugin-agent-codex": resolve(pluginsDir, "agent-codex/src/index.ts"),
      "@composio/ao-plugin-agent-opencode": resolve(pluginsDir, "agent-opencode/src/index.ts"),
      "@composio/ao-plugin-scm-github": resolve(pluginsDir, "scm-github/src/index.ts"),
    },
  },
});
