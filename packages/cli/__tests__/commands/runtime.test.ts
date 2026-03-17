import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Command } from "commander";
import { loadConfig } from "@composio/ao-core";
import { registerRuntime } from "../../src/commands/runtime.js";

let tmpDir: string;
let configPath: string;
let program: Command;
let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ao-runtime-test-"));
  mkdirSync(join(tmpDir, "my-app"), { recursive: true });
  mkdirSync(join(tmpDir, "backend"), { recursive: true });
  configPath = join(tmpDir, "agent-orchestrator.yaml");
  writeFileSync(
    configPath,
    [
      "defaults:",
      "  runtime: tmux",
      "  agent: claude-code",
      "  workspace: worktree",
      "  notifiers: [desktop]",
      "projects:",
      "  my-app:",
      "    name: My App",
      "    repo: org/my-app",
      `    path: ${join(tmpDir, "my-app")}`,
      "    defaultBranch: main",
      "    sessionPrefix: app",
      "  backend:",
      "    name: Backend",
      "    repo: org/backend",
      `    path: ${join(tmpDir, "backend")}`,
      "    defaultBranch: main",
      "    sessionPrefix: api",
      "    runtime: docker",
      "    runtimeConfig:",
      "      image: ghcr.io/example/ao-agent:latest",
      "",
    ].join("\n"),
    "utf-8",
  );
  process.env["AO_CONFIG_PATH"] = configPath;

  program = new Command();
  program.exitOverride();
  registerRuntime(program);

  consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`process.exit(${code})`);
  });
});

afterEach(() => {
  delete process.env["AO_CONFIG_PATH"];
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("runtime command", () => {
  it("shows effective runtimes for all projects", async () => {
    await program.parseAsync(["node", "test", "runtime", "show"]);

    const output = consoleLogSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain("my-app");
    expect(output).toContain("tmux (defaults.runtime)");
    expect(output).toContain("backend");
    expect(output).toContain("docker (project config)");
  });

  it("persists a project runtime override", async () => {
    await program.parseAsync(["node", "test", "runtime", "set", "my-app", "docker"]);

    const config = loadConfig(configPath);
    expect(config.projects["my-app"]?.runtime).toBe("docker");
    expect(readFileSync(configPath, "utf-8")).toContain("runtime: docker");

    const output = consoleLogSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain("Runtime for my-app set to docker");
  });

  it("clears a project runtime override", async () => {
    await program.parseAsync(["node", "test", "runtime", "clear", "backend"]);

    const config = loadConfig(configPath);
    expect(config.projects["backend"]?.runtime).toBeUndefined();

    const output = consoleLogSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain("Runtime override cleared for backend");
    expect(output).toContain("tmux (defaults.runtime)");
  });

  it("rejects unknown projects", async () => {
    await expect(
      program.parseAsync(["node", "test", "runtime", "set", "unknown", "docker"]),
    ).rejects.toThrow("process.exit(1)");

    const errors = consoleErrorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(errors).toContain("Unknown project: unknown");
  });
});
