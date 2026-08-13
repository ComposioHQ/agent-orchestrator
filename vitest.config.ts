import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
    // @aoagents/product-ui is a file: dependency with its own node_modules,
    // so without deduping, components that call hooks internally (e.g.
    // InspectorReviewsView's collapsible disclosure) render against a
    // different React module instance than the one driving the test's
    // render tree, which React rejects as an invalid hook call.
    dedupe: ["react", "react-dom", "react/jsx-runtime"],
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
  },
});
