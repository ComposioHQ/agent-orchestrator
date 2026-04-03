import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findConfigFile, loadConfig } from "../config.js";

describe("findConfigFile", () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns AO_CONFIG_PATH even when the file has malformed YAML", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "config-test-"));
    try {
      const malformedPath = join(tempRoot, "broken.yaml");
      writeFileSync(malformedPath, "{{invalid yaml::");
      process.env = { ...originalEnv, AO_CONFIG_PATH: malformedPath };

      expect(findConfigFile()).toBe(malformedPath);
      expect(() => loadConfig()).toThrow();
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
