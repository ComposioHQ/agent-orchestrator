import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 120_000,
    hookTimeout: 240_000, // Gemini loads MCPs before executing (~60s), requiring extended beforeAll budget
    pool: "forks",
    include: ["src/**/*.integration.test.ts"],
  },
});
