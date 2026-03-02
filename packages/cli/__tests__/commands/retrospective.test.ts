import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Retrospective } from "@composio/ao-core";

const {
  mockLoadConfig,
  mockResolveProjectRetroDir,
  mockLoadRetrospectives,
  mockGenerateRetrospective,
  mockSaveRetrospective,
} = vi.hoisted(() => ({
  mockLoadConfig: vi.fn(),
  mockResolveProjectRetroDir: vi.fn(),
  mockLoadRetrospectives: vi.fn(),
  mockGenerateRetrospective: vi.fn(),
  mockSaveRetrospective: vi.fn(),
}));

vi.mock("@composio/ao-core", () => ({
  loadConfig: mockLoadConfig,
  resolveProjectRetroDir: mockResolveProjectRetroDir,
  loadRetrospectives: mockLoadRetrospectives,
  generateRetrospective: mockGenerateRetrospective,
  saveRetrospective: mockSaveRetrospective,
}));

import { Command } from "commander";
import { registerRetrospective } from "../../src/commands/retrospective.js";

let program: Command;
let logs: string[];

function makeRetro(overrides: Partial<Retrospective> = {}): Retrospective {
  return {
    sessionId: "sess-1",
    projectId: "my-app",
    generatedAt: "2025-01-15T12:00:00Z",
    outcome: "success",
    timeline: [
      { event: "spawned", at: "2025-01-15T10:00:00Z", detail: "Session created" },
      { event: "pr_opened", at: "2025-01-15T11:00:00Z", detail: "PR #42 opened" },
    ],
    metrics: {
      totalDurationMs: 7200000,
      ciFailures: 1,
      reviewRounds: 2,
    },
    lessons: ["Always run tests before pushing"],
    reportCard: {
      sessionId: "sess-1",
      projectId: "my-app",
      duration: {
        startedAt: "2025-01-15T10:00:00Z",
        endedAt: "2025-01-15T12:00:00Z",
        totalMs: 7200000,
      },
      stateTransitions: [],
      ciAttempts: 2,
      reviewRounds: 2,
      outcome: "merged",
      prUrl: "https://github.com/org/repo/pull/42",
    },
    ...overrides,
  };
}

beforeEach(() => {
  program = new Command();
  program.exitOverride();
  registerRetrospective(program);

  logs = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`process.exit(${code})`);
  });

  mockLoadConfig.mockReset();
  mockResolveProjectRetroDir.mockReset();
  mockLoadRetrospectives.mockReset();
  mockGenerateRetrospective.mockReset();
  mockSaveRetrospective.mockReset();

  mockLoadConfig.mockReturnValue({ projects: { "my-app": { name: "My App" } } });
  mockResolveProjectRetroDir.mockReturnValue("/tmp/retros");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("retro list", () => {
  it("shows retrospectives table", async () => {
    mockLoadRetrospectives.mockReturnValue([
      makeRetro(),
      makeRetro({ sessionId: "sess-2", outcome: "failure" }),
    ]);

    await program.parseAsync(["node", "test", "retro", "list"]);

    const output = logs.join("\n");
    expect(output).toContain("Session");
    expect(output).toContain("Outcome");
    expect(output).toContain("sess-1");
    expect(output).toContain("sess-2");
    expect(output).toContain("2 retrospectives");
  });

  it("outputs JSON with --json flag", async () => {
    const retros = [makeRetro(), makeRetro({ sessionId: "sess-2" })];
    mockLoadRetrospectives.mockReturnValue(retros);

    await program.parseAsync(["node", "test", "retro", "list", "--json"]);

    const output = logs.join("\n");
    const parsed = JSON.parse(output);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].sessionId).toBe("sess-1");
    expect(parsed[1].sessionId).toBe("sess-2");
  });

  it("shows empty message when none found", async () => {
    mockLoadRetrospectives.mockReturnValue([]);

    await program.parseAsync(["node", "test", "retro", "list"]);

    const output = logs.join("\n");
    expect(output).toContain("No retrospectives found.");
  });

  it("passes limit option to loadRetrospectives", async () => {
    mockLoadRetrospectives.mockReturnValue([]);

    await program.parseAsync(["node", "test", "retro", "list", "-n", "5"]);

    expect(mockLoadRetrospectives).toHaveBeenCalledWith(
      "/tmp/retros",
      expect.objectContaining({ limit: 5 }),
    );
  });

  it("passes project filter to loadRetrospectives", async () => {
    mockLoadRetrospectives.mockReturnValue([]);

    await program.parseAsync(["node", "test", "retro", "list", "-p", "my-app"]);

    expect(mockLoadRetrospectives).toHaveBeenCalledWith(
      "/tmp/retros",
      expect.objectContaining({ projectId: "my-app" }),
    );
  });
});

describe("retro show", () => {
  it("shows retrospective detail", async () => {
    mockLoadRetrospectives.mockReturnValue([makeRetro()]);

    await program.parseAsync(["node", "test", "retro", "show", "sess-1"]);

    const output = logs.join("\n");
    expect(output).toContain("Retrospective:");
    expect(output).toContain("sess-1");
    expect(output).toContain("Duration:");
    expect(output).toContain("CI failures:");
    expect(output).toContain("Review rounds:");
    expect(output).toContain("Timeline:");
    expect(output).toContain("Session created");
    expect(output).toContain("Lessons:");
    expect(output).toContain("Always run tests before pushing");
  });

  it("outputs JSON with --json flag", async () => {
    const retro = makeRetro();
    mockLoadRetrospectives.mockReturnValue([retro]);

    await program.parseAsync(["node", "test", "retro", "show", "sess-1", "--json"]);

    const output = logs.join("\n");
    const parsed = JSON.parse(output);
    expect(parsed.sessionId).toBe("sess-1");
    expect(parsed.outcome).toBe("success");
    expect(parsed.metrics.ciFailures).toBe(1);
  });

  it("shows message when no retrospective found", async () => {
    mockLoadRetrospectives.mockReturnValue([]);

    await program.parseAsync(["node", "test", "retro", "show", "nonexistent"]);

    const output = logs.join("\n");
    expect(output).toContain('No retrospective found for session "nonexistent"');
  });

  it("shows PR URL when present", async () => {
    mockLoadRetrospectives.mockReturnValue([makeRetro()]);

    await program.parseAsync(["node", "test", "retro", "show", "sess-1"]);

    const output = logs.join("\n");
    expect(output).toContain("https://github.com/org/repo/pull/42");
  });

  it("passes sessionId and limit to loadRetrospectives", async () => {
    mockLoadRetrospectives.mockReturnValue([]);

    await program.parseAsync(["node", "test", "retro", "show", "sess-1"]);

    expect(mockLoadRetrospectives).toHaveBeenCalledWith(
      "/tmp/retros",
      expect.objectContaining({ sessionId: "sess-1", limit: 1 }),
    );
  });
});

describe("retro generate", () => {
  it("calls generateRetrospective and saves", async () => {
    const retro = makeRetro();
    mockGenerateRetrospective.mockReturnValue(retro);

    await program.parseAsync(["node", "test", "retro", "generate", "sess-1"]);

    expect(mockGenerateRetrospective).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ projects: expect.any(Object) }),
      "my-app",
    );
    expect(mockSaveRetrospective).toHaveBeenCalledWith(retro, "/tmp/retros");

    const output = logs.join("\n");
    expect(output).toContain("Retrospective generated for sess-1");
    expect(output).toContain("Saved to:");
  });

  it("shows message when generate returns null", async () => {
    mockGenerateRetrospective.mockReturnValue(null);

    await program.parseAsync(["node", "test", "retro", "generate", "sess-1"]);

    const output = logs.join("\n");
    expect(output).toContain('Could not generate retrospective for "sess-1"');
    expect(mockSaveRetrospective).not.toHaveBeenCalled();
  });

  it("throws when no projects configured", async () => {
    mockLoadConfig.mockReturnValue({ projects: {} });

    await expect(
      program.parseAsync(["node", "test", "retro", "generate", "sess-1"]),
    ).rejects.toThrow("process.exit");
  });

  it("displays outcome and duration after generating", async () => {
    const retro = makeRetro({ outcome: "partial", metrics: { totalDurationMs: 3600000, ciFailures: 0, reviewRounds: 1 } });
    mockGenerateRetrospective.mockReturnValue(retro);

    await program.parseAsync(["node", "test", "retro", "generate", "sess-1"]);

    const output = logs.join("\n");
    expect(output).toContain("partial");
    expect(output).toContain("1.0h");
  });
});
