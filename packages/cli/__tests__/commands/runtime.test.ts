import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as yamlParse } from "yaml";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockConfigPathRef } = vi.hoisted(() => ({
  mockConfigPathRef: { current: null as string | null },
}));

vi.mock("@composio/ao-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@composio/ao-core")>();
  return {
    ...actual,
    loadConfigWithPath: (configPath?: string) =>
      actual.loadConfigWithPath(configPath ?? mockConfigPathRef.current ?? undefined),
  };
});

import { registerRuntime } from "../../src/commands/runtime.js";

let tempDir: string;
let program: Command;
let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

function writeConfig(content: string): void {
  writeFileSync(mockConfigPathRef.current!, content, "utf-8");
}

function readConfig(): Record<string, unknown> {
  return yamlParse(readFileSync(mockConfigPathRef.current!, "utf-8")) as Record<string, unknown>;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "ao-runtime-command-"));
  mockConfigPathRef.current = join(tempDir, "agent-orchestrator.yaml");

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
  mockConfigPathRef.current = null;
  rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("runtime command", () => {
  it("shows a summary of default runtime and project overrides", async () => {
    writeConfig(`
defaults:
  runtime: tmux
projects:
  app:
    repo: org/app
    path: ~/app
    defaultBranch: main
    runtime: docker
    runtimeConfig:
      image: ghcr.io/composio/ao:test
  api:
    repo: org/api
    path: ~/api
    defaultBranch: main
`);

    await program.parseAsync(["node", "test", "runtime", "show"]);

    const output = consoleLogSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("Default runtime");
    expect(output).toContain("app");
    expect(output).toContain("docker");
    expect(output).toContain("image=ghcr.io/composio/ao:test");
    expect(output).toContain("api");
    expect(output).toContain("inherit (tmux)");
  });

  it("shows detailed runtime info for a project", async () => {
    writeConfig(`
defaults:
  runtime: tmux
projects:
  app:
    repo: org/app
    path: ~/app
    defaultBranch: main
    runtime: docker
    runtimeConfig:
      image: ghcr.io/composio/ao:test
      limits:
        memory: 4g
`);

    await program.parseAsync(["node", "test", "runtime", "show", "app"]);

    const output = consoleLogSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("Configured runtime");
    expect(output).toContain("Effective runtime");
    expect(output).toContain('"image": "ghcr.io/composio/ao:test"');
    expect(output).toContain('"memory": "4g"');
  });

  it("sets defaults.runtime when no project is provided", async () => {
    writeConfig(`
projects:
  app:
    repo: org/app
    path: ~/app
    defaultBranch: main
`);

    await program.parseAsync(["node", "test", "runtime", "set", "process"]);

    const raw = readConfig();
    expect((raw["defaults"] as Record<string, unknown>)["runtime"]).toBe("process");
  });

  it("sets a project docker runtime and merges runtimeConfig flags", async () => {
    writeConfig(`
defaults:
  runtime: tmux
projects:
  app:
    repo: org/app
    path: ~/app
    defaultBranch: main
    runtimeConfig:
      image: ghcr.io/composio/ao:old
`);

    await program.parseAsync([
      "node",
      "test",
      "runtime",
      "set",
      "docker",
      "app",
      "--image",
      "ghcr.io/composio/ao:new",
      "--memory",
      "4g",
      "--cpus",
      "2",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--tmpfs",
      "/tmp",
    ]);

    const raw = readConfig();
    const project = (raw["projects"] as Record<string, Record<string, unknown>>)["app"];
    expect(project["runtime"]).toBe("docker");
    expect(project["runtimeConfig"]).toEqual({
      image: "ghcr.io/composio/ao:new",
      limits: { memory: "4g", cpus: "2" },
      readOnlyRoot: true,
      capDrop: ["ALL"],
      tmpfs: ["/tmp"],
    });
  });

  it("clears a project runtime override and runtimeConfig together", async () => {
    writeConfig(`
defaults:
  runtime: tmux
projects:
  app:
    repo: org/app
    path: ~/app
    defaultBranch: main
    runtime: docker
    runtimeConfig:
      image: ghcr.io/composio/ao:test
`);

    await program.parseAsync(["node", "test", "runtime", "clear", "app"]);

    const raw = readConfig();
    const project = (raw["projects"] as Record<string, Record<string, unknown>>)["app"];
    expect(project["runtime"]).toBeUndefined();
    expect(project["runtimeConfig"]).toBeUndefined();
  });

  it("clears defaults.runtime and falls back to implicit tmux", async () => {
    writeConfig(`
defaults:
  runtime: docker
projects:
  app:
    repo: org/app
    path: ~/app
    defaultBranch: main
`);

    await program.parseAsync(["node", "test", "runtime", "clear"]);

    const raw = readConfig();
    expect((raw["defaults"] as Record<string, unknown>)["runtime"]).toBeUndefined();
  });

  it("rejects project runtime config flags without a project argument", async () => {
    writeConfig(`
projects:
  app:
    repo: org/app
    path: ~/app
    defaultBranch: main
`);

    await expect(
      program.parseAsync([
        "node",
        "test",
        "runtime",
        "set",
        "docker",
        "--image",
        "ghcr.io/composio/ao:test",
      ]),
    ).rejects.toThrow("process.exit(1)");

    const errors = consoleErrorSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(errors).toContain("Runtime config flags require a project argument");
  });

  it("rejects docker project selection without a runtimeConfig.image", async () => {
    writeConfig(`
defaults:
  runtime: tmux
projects:
  app:
    repo: org/app
    path: ~/app
    defaultBranch: main
`);

    await expect(
      program.parseAsync(["node", "test", "runtime", "set", "docker", "app"]),
    ).rejects.toThrow("process.exit(1)");

    const errors = consoleErrorSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(errors).toContain("needs runtimeConfig.image");
  });
});
