import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

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
    coverage: {
      provider: "v8",
      reporter: ["lcov"],
    },
  },
  resolve: {
    alias: [
      {
        find: "@composio/ao-core/scm-webhook-utils",
        replacement: resolve(__dirname, "../core/src/scm-webhook-utils.ts"),
      },
      {
        find: "@composio/ao-core/types",
        replacement: resolve(__dirname, "../core/src/types.ts"),
      },
      {
        find: "@composio/ao-core",
        replacement: resolve(__dirname, "../core/src/index.ts"),
      },
      {
        find: "@composio/ao-plugin-agent-claude-code",
        replacement: resolve(__dirname, "../plugins/agent-claude-code/src/index.ts"),
      },
      {
        find: "@composio/ao-plugin-agent-codex",
        replacement: resolve(__dirname, "../plugins/agent-codex/src/index.ts"),
      },
      {
        find: "@composio/ao-plugin-agent-aider",
        replacement: resolve(__dirname, "../plugins/agent-aider/src/index.ts"),
      },
      {
        find: "@composio/ao-plugin-agent-opencode",
        replacement: resolve(__dirname, "../plugins/agent-opencode/src/index.ts"),
      },
      {
        find: "@composio/ao-plugin-scm-github",
        replacement: resolve(__dirname, "../plugins/scm-github/src/index.ts"),
      },
    ],
  },
});
