import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readLocal(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf-8");
}

describe("web lib source compatibility", () => {
  it("does not use .js extensions for local src/lib imports", () => {
    const files = [
      "../api-auth.ts",
      "../format.ts",
      "../serialize.ts",
      "../services.ts",
    ];

    for (const file of files) {
      const source = readLocal(file);
      expect(source).not.toMatch(/from\s+["']\.\.?\/[^"']+\.js["']/);
    }
  });
});
