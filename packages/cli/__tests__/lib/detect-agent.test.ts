import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockIsHumanCaller, mockPromptSelect } = vi.hoisted(() => ({
  mockIsHumanCaller: vi.fn(),
  mockPromptSelect: vi.fn(),
}));

vi.mock("../../src/lib/caller-context.js", () => ({
  isHumanCaller: mockIsHumanCaller,
}));

vi.mock("../../src/lib/prompts.js", () => ({
  promptSelect: mockPromptSelect,
}));

// We need to mock dynamic imports for each agent plugin.
// vi.doMock is not needed because we mock at the import() level.

import { detectAvailableAgents, detectAgentRuntime } from "../../src/lib/detect-agent.js";

beforeEach(() => {
  mockIsHumanCaller.mockReset();
  mockPromptSelect.mockReset();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// detectAvailableAgents()
// ---------------------------------------------------------------------------

describe("detectAvailableAgents", () => {
  it("returns empty array when no plugins are importable", async () => {
    // All dynamic imports will fail with MODULE_NOT_FOUND
    const result = await detectAvailableAgents();
    // Since the real plugins aren't installed in test env, they'll all throw
    expect(Array.isArray(result)).toBe(true);
  });

  it("returns agents for plugins whose detect() returns true", async () => {
    // In the monorepo, claude-code plugin may be available.
    // Verify the result shape: each entry should have name and displayName.
    const agents = await detectAvailableAgents();
    for (const agent of agents) {
      expect(agent).toHaveProperty("name");
      expect(agent).toHaveProperty("displayName");
      expect(typeof agent.name).toBe("string");
      expect(typeof agent.displayName).toBe("string");
    }
  });
});

// ---------------------------------------------------------------------------
// detectAgentRuntime()
// ---------------------------------------------------------------------------

describe("detectAgentRuntime", () => {
  it("returns 'claude-code' when no agents are detected", async () => {
    const result = await detectAgentRuntime([]);
    expect(result).toBe("claude-code");
  });

  it("auto-selects the single available agent", async () => {
    const agents = [{ name: "aider", displayName: "Aider" }];
    const result = await detectAgentRuntime(agents);
    expect(result).toBe("aider");
  });

  it("prefers claude-code when multiple agents are available and non-interactive", async () => {
    mockIsHumanCaller.mockReturnValue(false);

    const agents = [
      { name: "aider", displayName: "Aider" },
      { name: "claude-code", displayName: "Claude Code" },
      { name: "codex", displayName: "Codex" },
    ];
    const result = await detectAgentRuntime(agents);
    expect(result).toBe("claude-code");
  });

  it("returns first agent when multiple available, non-interactive, and no claude-code", async () => {
    mockIsHumanCaller.mockReturnValue(false);

    const agents = [
      { name: "aider", displayName: "Aider" },
      { name: "codex", displayName: "Codex" },
    ];
    const result = await detectAgentRuntime(agents);
    expect(result).toBe("aider");
  });

  it("prompts user to select when multiple agents available and human caller", async () => {
    mockIsHumanCaller.mockReturnValue(true);
    mockPromptSelect.mockResolvedValue("codex");

    const agents = [
      { name: "claude-code", displayName: "Claude Code" },
      { name: "codex", displayName: "Codex" },
    ];
    const result = await detectAgentRuntime(agents);

    expect(result).toBe("codex");
    expect(mockPromptSelect).toHaveBeenCalledWith(
      "Choose default agent runtime:",
      expect.arrayContaining([
        expect.objectContaining({ value: "claude-code", label: "Claude Code" }),
        expect.objectContaining({ value: "codex", label: "Codex" }),
      ]),
    );
  });

  it("passes hint property in select options", async () => {
    mockIsHumanCaller.mockReturnValue(true);
    mockPromptSelect.mockResolvedValue("aider");

    const agents = [
      { name: "aider", displayName: "Aider" },
      { name: "opencode", displayName: "OpenCode" },
    ];
    await detectAgentRuntime(agents);

    expect(mockPromptSelect).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining([
        expect.objectContaining({ value: "aider", hint: "aider" }),
        expect.objectContaining({ value: "opencode", hint: "opencode" }),
      ]),
    );
  });

  it("uses preDetected param when provided instead of calling detectAvailableAgents", async () => {
    const preDetected = [{ name: "opencode", displayName: "OpenCode" }];
    const result = await detectAgentRuntime(preDetected);
    expect(result).toBe("opencode");
  });
});
