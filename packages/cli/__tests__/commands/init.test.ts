import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";

import { Command } from "commander";
import { registerInit } from "../../src/commands/init.js";

let tmpDir: string;

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("init command", () => {
  it("rejects when config file already exists", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "ao-init-test-"));
    const outputPath = join(tmpDir, "agent-orchestrator.yaml");
    writeFileSync(outputPath, "existing: true\n");

    const program = new Command();
    program.exitOverride();
    registerInit(program);

    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });

    await expect(
      program.parseAsync(["node", "test", "init", "--output", outputPath]),
    ).rejects.toThrow("process.exit(1)");

    // Original file should be untouched
    expect(existsSync(outputPath)).toBe(true);
  });

  it("auto mode uses port 3000 when it is available", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "ao-init-test-"));
    const outputPath = join(tmpDir, "agent-orchestrator.yaml");

    const program = new Command();
    program.exitOverride();
    registerInit(program);

    vi.spyOn(console, "log").mockImplementation(() => {});

    await program.parseAsync(["node", "test", "init", "--auto", "--output", outputPath]);

    const content = readFileSync(outputPath, "utf-8");
    expect(content).toContain("port: 3000");
  });

  it("auto mode picks next free port when 3000 is occupied", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "ao-init-test-"));
    const outputPath = join(tmpDir, "agent-orchestrator.yaml");

    // Occupy port 3000
    const blocker = createServer();
    await new Promise<void>((resolve) => {
      blocker.listen(3000, "127.0.0.1", () => resolve());
    });

    try {
      const program = new Command();
      program.exitOverride();
      registerInit(program);

      vi.spyOn(console, "log").mockImplementation(() => {});

      await program.parseAsync(["node", "test", "init", "--auto", "--output", outputPath]);

      const content = readFileSync(outputPath, "utf-8");
      // Should NOT be 3000 since we're occupying it
      expect(content).not.toContain("port: 3000");
      // Should pick 3001 (or higher if 3001 is also taken)
      const portMatch = content.match(/port: (\d+)/);
      expect(portMatch).toBeTruthy();
      const port = parseInt(portMatch![1], 10);
      expect(port).toBeGreaterThan(3000);
      expect(port).toBeLessThan(3100);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});
