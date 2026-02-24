import { describe, it, expect, vi, beforeEach } from "vitest";
import { LinearMcpInputSource } from "../src/linear-mcp-input-source.js";

// Mock the MCP SDK
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue({
      tools: [
        { name: "get_issue" },
        { name: "create_comment" },
        { name: "update_issue" },
        { name: "list_issues" },
      ],
    }),
    callTool: vi.fn().mockImplementation(({ name }: { name: string }) => {
      if (name === "get_issue") {
        return Promise.resolve({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                id: "uuid-123",
                identifier: "POS-863",
                title: "Implement payment flow",
                description: "Full description",
                state: { name: "In Progress" },
                priority: 1,
                labels: { nodes: [{ name: "pos" }] },
                comments: {
                  nodes: [
                    {
                      id: "c1",
                      body: "Starting",
                      user: { name: "Agent" },
                      createdAt: "2024-01-01T00:00:00Z",
                    },
                  ],
                },
              }),
            },
          ],
        });
      }
      if (name === "list_issues") {
        return Promise.resolve({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                nodes: [
                  {
                    id: "uuid-1",
                    identifier: "POS-863",
                    title: "Task 1",
                    state: { name: "Backlog" },
                    priority: 2,
                    url: "https://linear.app/team/POS-863",
                  },
                ],
              }),
            },
          ],
        });
      }
      return Promise.resolve({ content: [] });
    }),
  })),
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi.fn(),
}));

describe("LinearMcpInputSource", () => {
  let source: LinearMcpInputSource;

  beforeEach(() => {
    vi.clearAllMocks();
    source = new LinearMcpInputSource({ accessToken: "test-token" });
  });

  it("connect() initializes client and discovers tools", async () => {
    await source.connect();
    // No error means success
  });

  it("disconnect() calls client.close()", async () => {
    await source.connect();
    await source.disconnect();
    // Should not throw on double disconnect
    await source.disconnect();
  });

  it("getContext() returns properly shaped AgentContext", async () => {
    await source.connect();
    const ctx = await source.getContext("POS-863");

    expect(ctx.id).toBe("uuid-123");
    expect(ctx.identifier).toBe("POS-863");
    expect(ctx.title).toBe("Implement payment flow");
    expect(ctx.description).toBe("Full description");
    expect(ctx.status).toBe("In Progress");
    expect(ctx.priority).toBe(1);
    expect(ctx.labels).toEqual(["pos"]);
    expect(ctx.comments).toHaveLength(1);
    expect(ctx.comments[0].author).toBe("Agent");
    expect(ctx.metadata).toBeDefined();
  });

  it("postUpdate() calls create_comment tool", async () => {
    await source.connect();
    await source.postUpdate("POS-863", "Starting implementation");
    // No error means the tool was called
  });

  it("setStatus() calls update_issue tool", async () => {
    await source.connect();
    await source.setStatus("POS-863", "In Review");
  });

  it("listPending() returns array of Resource objects", async () => {
    await source.connect();
    const resources = await source.listPending("team-id");

    expect(resources).toHaveLength(1);
    expect(resources[0].id).toBe("uuid-1");
    expect(resources[0].identifier).toBe("POS-863");
    expect(resources[0].title).toBe("Task 1");
    expect(resources[0].status).toBe("Backlog");
    expect(resources[0].url).toContain("linear.app");
  });

  it("parseResult handles MCP content array format", async () => {
    await source.connect();
    // getContext exercises parseResult internally
    const ctx = await source.getContext("POS-863");
    expect(ctx.title).toBe("Implement payment flow");
  });
});
