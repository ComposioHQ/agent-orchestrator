import { describe, it, expect, vi, afterEach } from "vitest";
import { Command } from "commander";
import { registerDoctor } from "../../src/commands/doctor.js";

afterEach(() => {
  vi.restoreAllMocks();
});

// Helper to run the doctor command and capture output
async function runDoctor(args: string[] = []): Promise<{ logs: string[]; exitCode: number | null }> {
  const logs: string[] = [];
  let exitCode: number | null = null;

  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(" "));
  });
  vi.spyOn(process, "exit").mockImplementation((code) => {
    exitCode = typeof code === "number" ? code : 0;
    throw new Error(`process.exit(${code})`);
  });

  const program = new Command();
  program.exitOverride();
  registerDoctor(program);

  try {
    await program.parseAsync(["node", "test", "doctor", ...args]);
  } catch (err) {
    if (err instanceof Error && !err.message.startsWith("process.exit")) {
      throw err;
    }
  }

  return { logs, exitCode };
}

describe("doctor command", () => {
  it("registers on program with correct name and description", () => {
    const program = new Command();
    registerDoctor(program);
    const cmd = program.commands.find((c) => c.name() === "doctor");
    expect(cmd).toBeDefined();
    expect(cmd!.description()).toContain("health");
  });

  it("checks Node.js version and reports pass for current runtime", async () => {
    const { logs } = await runDoctor();
    const output = logs.join("\n");
    expect(output).toContain("Node.js");
    // Current runtime should be >= 20
    expect(output).toMatch(/✓ Node\.js/);
  });

  it("checks for Git availability", async () => {
    const { logs } = await runDoctor();
    const output = logs.join("\n");
    expect(output).toContain("Git");
  });

  it("checks for tmux availability", async () => {
    const { logs } = await runDoctor();
    const output = logs.join("\n");
    expect(output).toContain("tmux");
  });

  it("checks for GitHub CLI", async () => {
    const { logs } = await runDoctor();
    const output = logs.join("\n");
    expect(output).toContain("GitHub CLI");
  });

  it("shows config file check", async () => {
    const { logs } = await runDoctor();
    const output = logs.join("\n");
    expect(output).toContain("Config file");
  });

  it("shows summary with pass/warn/fail counts", async () => {
    const { logs } = await runDoctor();
    const output = logs.join("\n");
    // Should have at least one passed check
    expect(output).toMatch(/\d+ passed/);
  });

  it("does not check agent CLIs by default", async () => {
    const { logs } = await runDoctor();
    const output = logs.join("\n");
    expect(output).not.toContain("Agent: claude-code");
    expect(output).not.toContain("Agent: codex");
  });

  it("checks agent CLIs when --agents flag is passed", async () => {
    const { logs } = await runDoctor();
    // Without --agents, no agent checks
    const output = logs.join("\n");
    expect(output).not.toContain("Agent:");

    // With --agents
    const { logs: agentLogs } = await runDoctor(["--agents"]);
    const agentOutput = agentLogs.join("\n");
    expect(agentOutput).toContain("Agent: claude-code");
    expect(agentOutput).toContain("Agent: codex");
    expect(agentOutput).toContain("Agent: aider");
    expect(agentOutput).toContain("Agent: opencode");
  });

  it("shows data directory check", async () => {
    const { logs } = await runDoctor();
    const output = logs.join("\n");
    expect(output).toContain("Data directory");
  });
});
