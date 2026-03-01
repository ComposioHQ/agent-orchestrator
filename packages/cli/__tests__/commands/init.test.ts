import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";

import { Command } from "commander";
import { parse as yamlParse } from "yaml";
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

  it("auto mode tells user when default port is busy and which port it picked", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "ao-init-test-"));
    const outputPath = join(tmpDir, "agent-orchestrator.yaml");

    // Occupy port 3000
    const blocker = createServer();
    await new Promise<void>((resolve) => {
      blocker.listen(3000, "127.0.0.1", () => resolve());
    });

    try {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const program = new Command();
      program.exitOverride();
      registerInit(program);

      await program.parseAsync(["node", "test", "init", "--auto", "--output", outputPath]);

      const logCalls = logSpy.mock.calls.map((args) => args.join(" "));
      const busyMessage = logCalls.find((msg) => msg.includes("Port 3000 is busy"));
      expect(busyMessage).toBeDefined();
      expect(busyMessage).toContain("instead");
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it("auto mode writes name and sessionPrefix to project config", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "ao-init-test-"));
    const outputPath = join(tmpDir, "agent-orchestrator.yaml");

    const program = new Command();
    program.exitOverride();
    registerInit(program);

    vi.spyOn(console, "log").mockImplementation(() => {});

    await program.parseAsync(["node", "test", "init", "--auto", "--output", outputPath]);

    const content = readFileSync(outputPath, "utf-8");
    const config = yamlParse(content) as Record<string, unknown>;
    const projects = config.projects as Record<string, Record<string, unknown>>;
    const projectIds = Object.keys(projects);
    expect(projectIds.length).toBeGreaterThan(0);

    const projectId = projectIds[0];
    const project = projects[projectId];

    // BUG-01: sessionPrefix must exist and not be "undefined"
    expect(project.sessionPrefix).toBeDefined();
    expect(project.sessionPrefix).not.toBe("undefined");
    expect(typeof project.sessionPrefix).toBe("string");
    expect((project.sessionPrefix as string).length).toBeGreaterThan(0);

    // BUG-02: name must match the project ID
    expect(project.name).toBe(projectId);
  });

  it("auto mode warns when no free port is found", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "ao-init-test-"));
    const outputPath = join(tmpDir, "agent-orchestrator.yaml");

    // Mock isPortAvailable to always return false (all ports busy)
    const webDirModule = await import("../../src/lib/web-dir.js");
    vi.spyOn(webDirModule, "isPortAvailable").mockResolvedValue(false);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = new Command();
    program.exitOverride();
    registerInit(program);

    await program.parseAsync(["node", "test", "init", "--auto", "--output", outputPath]);

    // Should warn about no free port
    const logCalls = logSpy.mock.calls.map((args) => args.join(" "));
    const hasPortWarning = logCalls.some((msg) => msg.includes("No free port found"));
    expect(hasPortWarning).toBe(true);

    // Should still write config with fallback port 3000
    const content = readFileSync(outputPath, "utf-8");
    expect(content).toContain("port: 3000");
  });

  it("--smart flag description includes 'coming soon'", () => {
    const program = new Command();
    registerInit(program);

    const initCmd = program.commands.find((c) => c.name() === "init");
    expect(initCmd).toBeDefined();

    const smartOption = initCmd!.options.find((o) => o.long === "--smart");
    expect(smartOption).toBeDefined();
    expect(smartOption!.description).toContain("coming soon");
  });

  it("auto mode sessionPrefix uses core generateSessionPrefix heuristics", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "ao-init-test-"));
    const outputPath = join(tmpDir, "agent-orchestrator.yaml");

    // Run from a directory whose basename is kebab-case
    // The cwd() in init.ts determines the projectId via basename()
    // We can't easily control cwd in tests, but we can verify the prefix
    // is consistent with generateSessionPrefix for whatever projectId is used
    const { generateSessionPrefix } = await import("@composio/ao-core");

    const program = new Command();
    program.exitOverride();
    registerInit(program);

    vi.spyOn(console, "log").mockImplementation(() => {});

    await program.parseAsync(["node", "test", "init", "--auto", "--output", outputPath]);

    const content = readFileSync(outputPath, "utf-8");
    const config = yamlParse(content) as Record<string, unknown>;
    const projects = config.projects as Record<string, Record<string, unknown>>;
    const projectId = Object.keys(projects)[0];
    const project = projects[projectId];

    // sessionPrefix must match what generateSessionPrefix produces
    expect(project.sessionPrefix).toBe(generateSessionPrefix(projectId));
  });
});
