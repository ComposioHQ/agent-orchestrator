import { describe, expect, it } from "vitest";
import { composeFacetedPrompt } from "../faceted-prompting.js";

describe("composeFacetedPrompt", () => {
  it("places persona in system prompt", () => {
    const result = composeFacetedPrompt({
      persona: { content: "You are a strict reviewer." },
      instruction: { content: "Review this patch." },
    });
    expect(result.systemPrompt).toContain("strict reviewer");
    expect(result.userMessage).toContain("Review this patch.");
  });

  it("applies policy sandwich in user message", () => {
    const result = composeFacetedPrompt({
      policies: [{ content: "Never fabricate facts." }],
      instruction: { content: "Summarize changes." },
    });
    const firstPolicy = result.userMessage.indexOf("## Policy");
    const secondPolicy = result.userMessage.lastIndexOf("## Policy");
    const instruction = result.userMessage.indexOf("## Instruction");
    expect(firstPolicy).toBeGreaterThanOrEqual(0);
    expect(secondPolicy).toBeGreaterThan(firstPolicy);
    expect(instruction).toBeGreaterThan(firstPolicy);
    expect(instruction).toBeLessThan(secondPolicy);
  });

  it("truncates oversized facets and includes source hint", () => {
    const longContent = "x".repeat(20);
    const result = composeFacetedPrompt({
      knowledge: [{ content: longContent, sourcePath: ".takt/knowledge.md" }],
      maxFacetChars: 8,
    });
    expect(result.userMessage).toContain("...[truncated]");
    expect(result.userMessage).toContain(".takt/knowledge.md");
  });

  it("does not throw when a facet is missing content", () => {
    expect(() =>
      composeFacetedPrompt({
        knowledge: [{ content: undefined as unknown as string, sourcePath: "knowledge.md" }],
      }),
    ).not.toThrow();
  });
});
