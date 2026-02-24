/**
 * Type-level compile checks for McpInputSource, AgentContext, Resource.
 * If these types compile, the interfaces are correctly defined.
 */

import { describe, it, expect } from "vitest";
import type {
  McpInputSource,
  AgentContext,
  AgentContextComment,
  Resource,
} from "../types.js";

describe("McpInputSource interface", () => {
  it("compiles with a conforming implementation", () => {
    // This is a type-level check — if it compiles, the interface is correct
    const _check: McpInputSource = {
      connect: async () => {},
      disconnect: async () => {},
      getContext: async (id): Promise<AgentContext> => ({
        id,
        title: "",
        description: "",
        status: "",
        labels: [],
        comments: [],
        metadata: {},
      }),
      postUpdate: async () => {},
      setStatus: async () => {},
      listPending: async (): Promise<Resource[]> => [],
    };

    expect(_check).toBeDefined();
  });

  it("AgentContext supports optional fields", () => {
    const ctx: AgentContext = {
      id: "abc-123",
      identifier: "POS-863",
      title: "Implement payment flow",
      description: "Full description here",
      status: "In Progress",
      priority: 1,
      labels: ["pos", "payment"],
      comments: [
        {
          id: "c1",
          body: "Starting work",
          author: "agent",
          createdAt: "2024-01-01T00:00:00Z",
        },
      ],
      metadata: { customField: "value" },
    };

    expect(ctx.identifier).toBe("POS-863");
    expect(ctx.priority).toBe(1);
  });

  it("AgentContext works without optional fields", () => {
    const ctx: AgentContext = {
      id: "abc-123",
      title: "Test",
      description: "",
      status: "Backlog",
      labels: [],
      comments: [],
      metadata: {},
    };

    expect(ctx.identifier).toBeUndefined();
    expect(ctx.priority).toBeUndefined();
  });

  it("Resource supports optional fields", () => {
    const resource: Resource = {
      id: "r1",
      identifier: "POS-863",
      title: "Some task",
      status: "Todo",
      priority: 2,
      url: "https://linear.app/team/POS-863",
    };

    expect(resource.identifier).toBe("POS-863");
    expect(resource.url).toContain("linear.app");
  });

  it("Resource works without optional fields", () => {
    const resource: Resource = {
      id: "r1",
      title: "Some task",
      status: "Todo",
    };

    expect(resource.identifier).toBeUndefined();
    expect(resource.priority).toBeUndefined();
    expect(resource.url).toBeUndefined();
  });

  it("AgentContextComment has required shape", () => {
    const comment: AgentContextComment = {
      id: "comment-1",
      body: "This is a comment",
      author: "user@example.com",
      createdAt: "2024-06-15T10:30:00Z",
    };

    expect(comment.id).toBe("comment-1");
    expect(comment.body).toBe("This is a comment");
  });
});
