import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/__tests__/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}", "server/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["lcov"],
      include: ["src/**/*.{ts,tsx}", "server/**/*.ts"],
    },
  },
  resolve: {
    alias: [
      { find: "@aoagents/ao-core/types", replacement: resolve(__dirname, "../core/src/types.ts") },
      {
        find: "@aoagents/ao-core",
        replacement: resolve(__dirname, "../core/src/index.ts"),
      },
      {
        find: "@aoagents/ao-plugin-runtime-tmux",
        replacement: resolve(__dirname, "../plugins/runtime-tmux/src/index.ts"),
      },
      {
        find: "@aoagents/ao-plugin-agent-claude-code",
        replacement: resolve(__dirname, "../plugins/agent-claude-code/src/index.ts"),
      },
      {
        find: "@aoagents/ao-plugin-agent-opencode",
        replacement: resolve(__dirname, "../plugins/agent-opencode/src/index.ts"),
      },
      {
        find: "@aoagents/ao-plugin-workspace-worktree",
        replacement: resolve(__dirname, "../plugins/workspace-worktree/src/index.ts"),
      },
      {
        find: "@aoagents/ao-plugin-scm-github",
        replacement: resolve(__dirname, "../plugins/scm-github/src/index.ts"),
      },
      {
        find: "@aoagents/ao-plugin-tracker-github",
        replacement: resolve(__dirname, "../plugins/tracker-github/src/index.ts"),
      },
      {
        find: "@aoagents/ao-plugin-tracker-linear",
        replacement: resolve(__dirname, "../plugins/tracker-linear/src/index.ts"),
      },
      { find: "server-only", replacement: resolve(__dirname, "./src/__tests__/server-only-mock.ts") },
      { find: "@", replacement: resolve(__dirname, "./src") },
    ],
  },
});
