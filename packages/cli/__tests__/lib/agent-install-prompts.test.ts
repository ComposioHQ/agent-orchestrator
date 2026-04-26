/**
 * Tests for lib/agent-install-prompts.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDetectAvailableAgents, mockPromptSelect, mockCanPromptForInstall, mockRunInteractiveCommand } =
  vi.hoisted(() => ({
    mockDetectAvailableAgents: vi.fn(),
    mockPromptSelect: vi.fn(),
    mockCanPromptForInstall: vi.fn(),
    mockRunInteractiveCommand: vi.fn(),
  }));

vi.mock("../../src/lib/detect-agent.js", () => ({
  detectAvailableAgents: mockDetectAvailableAgents,
}));

vi.mock("../../src/lib/prompts.js", () => ({
  promptSelect: mockPromptSelect,
}));

vi.mock("../../src/lib/installer.js", () => ({
  canPromptForInstall: mockCanPromptForInstall,
  runInteractiveCommand: mockRunInteractiveCommand,
}));

import {
  promptAgentSelection,
  promptInstallAgentRuntime,
} from "../../src/lib/agent-install-prompts.js";

beforeEach(() => {
  mockDetectAvailableAgents.mockReset();
  mockPromptSelect.mockReset();
  mockCanPromptForInstall.mockReset();
  mockRunInteractiveCommand.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("promptAgentSelection", () => {
  it("returns null when prompting is not available", async () => {
    mockCanPromptForInstall.mockReturnValue(false);
    await expect(promptAgentSelection()).resolves.toBeNull();
  });

  it("returns null when no agent runtimes are detected", async () => {
    mockCanPromptForInstall.mockReturnValue(true);
    mockDetectAvailableAgents.mockResolvedValue([]);
    await expect(promptAgentSelection()).resolves.toBeNull();
  });

  it("prompts for orchestrator + worker and returns both", async () => {
    mockCanPromptForInstall.mockReturnValue(true);
    mockDetectAvailableAgents.mockResolvedValue([
      { name: "claude-code", displayName: "Claude Code" },
      { name: "codex", displayName: "Codex" },
    ]);
    mockPromptSelect.mockResolvedValueOnce("claude-code").mockResolvedValueOnce("codex");
    await expect(promptAgentSelection()).resolves.toEqual({
      orchestratorAgent: "claude-code",
      workerAgent: "codex",
    });
    expect(mockPromptSelect).toHaveBeenCalledTimes(2);
  });
});

describe("promptInstallAgentRuntime", () => {
  it("returns the detected list unchanged when at least one runtime is present", async () => {
    mockCanPromptForInstall.mockReturnValue(true);
    const detected = [{ name: "claude-code", displayName: "Claude Code" }];
    await expect(promptInstallAgentRuntime(detected)).resolves.toEqual(detected);
    expect(mockPromptSelect).not.toHaveBeenCalled();
  });

  it("returns the empty list when prompting is unavailable", async () => {
    mockCanPromptForInstall.mockReturnValue(false);
    await expect(promptInstallAgentRuntime([])).resolves.toEqual([]);
    expect(mockPromptSelect).not.toHaveBeenCalled();
  });

  it("returns unchanged list when user picks skip", async () => {
    mockCanPromptForInstall.mockReturnValue(true);
    mockPromptSelect.mockResolvedValue("skip");
    await expect(promptInstallAgentRuntime([])).resolves.toEqual([]);
    expect(mockRunInteractiveCommand).not.toHaveBeenCalled();
  });

  it("installs and re-detects when a runtime is selected", async () => {
    mockCanPromptForInstall.mockReturnValue(true);
    mockPromptSelect.mockResolvedValue("claude-code");
    mockRunInteractiveCommand.mockResolvedValue(undefined);
    mockDetectAvailableAgents.mockResolvedValue([
      { name: "claude-code", displayName: "Claude Code" },
    ]);
    const result = await promptInstallAgentRuntime([]);
    expect(result).toEqual([{ name: "claude-code", displayName: "Claude Code" }]);
    expect(mockRunInteractiveCommand).toHaveBeenCalledWith("npm", [
      "install",
      "-g",
      "@anthropic-ai/claude-code",
    ]);
  });

  it("returns original list when install command fails", async () => {
    mockCanPromptForInstall.mockReturnValue(true);
    mockPromptSelect.mockResolvedValue("codex");
    mockRunInteractiveCommand.mockRejectedValue(new Error("npm failed"));
    await expect(promptInstallAgentRuntime([])).resolves.toEqual([]);
  });
});
