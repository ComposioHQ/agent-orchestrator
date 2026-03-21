import { describe, it, expect, vi, beforeEach } from "vitest";
import { classifyTaskComplexity } from "../session-manager.js";

// Use vi.hoisted so mockCreate is available inside the vi.mock factory
// (vi.mock calls are hoisted before variable declarations)
const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));

vi.mock("@anthropic-ai/sdk", () => {
  // Must use a class/function (not arrow) so it works as a constructor
  class MockAnthropic {
    messages = { create: mockCreate };
  }
  return { default: MockAnthropic };
});

describe("classifyTaskComplexity", () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it("returns 'simple' when Claude responds with 'simple'", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "simple" }],
    });

    const result = await classifyTaskComplexity("Fix typo in README");
    expect(result).toBe("simple");
  });

  it("returns 'complex' when Claude responds with 'complex'", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "complex" }],
    });

    const result = await classifyTaskComplexity(
      "Implement OAuth2 authentication with multi-provider support",
    );
    expect(result).toBe("complex");
  });

  it("trims and lowercases the response before comparing", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "  Simple  " }],
    });

    const result = await classifyTaskComplexity("Update config value");
    expect(result).toBe("simple");
  });

  it("falls back to 'complex' on ambiguous response", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "I cannot determine" }],
    });

    const result = await classifyTaskComplexity("Some task");
    expect(result).toBe("complex");
  });

  it("falls back to 'complex' when Anthropic SDK throws", async () => {
    mockCreate.mockRejectedValueOnce(new Error("API error"));

    const result = await classifyTaskComplexity("Some task");
    expect(result).toBe("complex");
  });

  it("returns 'complex' immediately for empty input without calling API", async () => {
    const result = await classifyTaskComplexity("");
    expect(result).toBe("complex");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("returns 'complex' immediately for whitespace-only input", async () => {
    const result = await classifyTaskComplexity("   ");
    expect(result).toBe("complex");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("calls Claude Haiku model for cost efficiency", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "simple" }],
    });

    await classifyTaskComplexity("Fix typo");
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-haiku-4-5-20251001",
      }),
    );
  });

  it("includes the task description in the prompt", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "simple" }],
    });

    const taskDescription = "Add docstring to utils.py";
    await classifyTaskComplexity(taskDescription);
    const callArgs = mockCreate.mock.calls[0]?.[0] as
      | { messages?: Array<{ content?: string }> }
      | undefined;
    const userMessage = callArgs?.messages?.[0]?.content;
    expect(userMessage).toContain(taskDescription);
  });
});
