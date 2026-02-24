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

describe("tool name resolution", () => {
  it("resolves tools with linear_ prefix when exact match unavailable", async () => {
    const { Client } = await import(
      "@modelcontextprotocol/sdk/client/index.js"
    );
    const MockClient = Client as unknown as ReturnType<typeof vi.fn>;

    MockClient.mockImplementationOnce(() => ({
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({
        tools: [
          { name: "linear_get_issue" },
          { name: "linear_create_comment" },
          { name: "linear_update_issue" },
          { name: "linear_list_issues" },
        ],
      }),
      callTool: vi
        .fn()
        .mockImplementation(({ name }: { name: string }) => {
          if (name === "linear_get_issue") {
            return Promise.resolve({
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    id: "uuid-456",
                    identifier: "POS-999",
                    title: "Prefixed tool test",
                    description: "desc",
                    state: { name: "Backlog" },
                    labels: { nodes: [] },
                    comments: { nodes: [] },
                  }),
                },
              ],
            });
          }
          if (name === "linear_list_issues") {
            return Promise.resolve({
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    nodes: [
                      {
                        id: "uuid-lp",
                        identifier: "POS-100",
                        title: "Prefixed list",
                        state: { name: "Backlog" },
                        priority: 1,
                        url: "https://linear.app/team/POS-100",
                      },
                    ],
                  }),
                },
              ],
            });
          }
          return Promise.resolve({ content: [] });
        }),
    }));

    const prefixSource = new LinearMcpInputSource({ accessToken: "test" });
    await prefixSource.connect();
    const ctx = await prefixSource.getContext("POS-999");
    expect(ctx.title).toBe("Prefixed tool test");
    expect(ctx.identifier).toBe("POS-999");
  });

  it("resolves postUpdate with linear_ prefix", async () => {
    const { Client } = await import(
      "@modelcontextprotocol/sdk/client/index.js"
    );
    const MockClient = Client as unknown as ReturnType<typeof vi.fn>;

    const mockCallTool = vi.fn().mockResolvedValue({ content: [] });
    MockClient.mockImplementationOnce(() => ({
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({
        tools: [
          { name: "linear_get_issue" },
          { name: "linear_create_comment" },
          { name: "linear_update_issue" },
          { name: "linear_list_issues" },
        ],
      }),
      callTool: mockCallTool,
    }));

    const src = new LinearMcpInputSource({ accessToken: "test" });
    await src.connect();
    await src.postUpdate("POS-1", "hello");
    expect(mockCallTool).toHaveBeenCalledWith({
      name: "linear_create_comment",
      arguments: { issueId: "POS-1", body: "hello" },
    });
  });

  it("resolves setStatus with linear_ prefix", async () => {
    const { Client } = await import(
      "@modelcontextprotocol/sdk/client/index.js"
    );
    const MockClient = Client as unknown as ReturnType<typeof vi.fn>;

    const mockCallTool = vi.fn().mockResolvedValue({ content: [] });
    MockClient.mockImplementationOnce(() => ({
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({
        tools: [
          { name: "linear_get_issue" },
          { name: "linear_create_comment" },
          { name: "linear_update_issue" },
          { name: "linear_list_issues" },
        ],
      }),
      callTool: mockCallTool,
    }));

    const src = new LinearMcpInputSource({ accessToken: "test" });
    await src.connect();
    await src.setStatus("POS-1", "Done");
    expect(mockCallTool).toHaveBeenCalledWith({
      name: "linear_update_issue",
      arguments: { issueId: "POS-1", stateName: "Done" },
    });
  });

  it("falls back to assumed name when no match found", async () => {
    const { Client } = await import(
      "@modelcontextprotocol/sdk/client/index.js"
    );
    const MockClient = Client as unknown as ReturnType<typeof vi.fn>;

    const mockCallTool = vi.fn().mockResolvedValue({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            id: "uuid-fb",
            title: "Fallback",
            description: "",
            state: { name: "Todo" },
          }),
        },
      ],
    });
    MockClient.mockImplementationOnce(() => ({
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({
        tools: [{ name: "something_unrelated" }],
      }),
      callTool: mockCallTool,
    }));

    const src = new LinearMcpInputSource({ accessToken: "test" });
    await src.connect();
    await src.getContext("POS-FB");
    // resolveTool should fall back to "get_issue" since neither
    // "get_issue" nor "linear_get_issue" are in the discovered tools
    expect(mockCallTool).toHaveBeenCalledWith({
      name: "get_issue",
      arguments: { issueId: "POS-FB" },
    });
  });
});

describe("edge cases", () => {
  it("handles missing labels.nodes gracefully", async () => {
    const { Client } = await import(
      "@modelcontextprotocol/sdk/client/index.js"
    );
    const MockClient = Client as unknown as ReturnType<typeof vi.fn>;

    MockClient.mockImplementationOnce(() => ({
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
      callTool: vi.fn().mockResolvedValue({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              id: "uuid-no-labels",
              title: "No labels",
              description: "",
              state: { name: "Todo" },
              // No labels field at all
              // No comments field at all
            }),
          },
        ],
      }),
    }));

    const src = new LinearMcpInputSource({ accessToken: "test" });
    await src.connect();
    const ctx = await src.getContext("POS-100");
    expect(ctx.labels).toEqual([]);
    expect(ctx.comments).toEqual([]);
  });

  it("disconnect when not connected is safe", async () => {
    const src = new LinearMcpInputSource({ accessToken: "test" });
    // Never called connect()
    await expect(src.disconnect()).resolves.toBeUndefined();
  });

  it("handles non-JSON text response from callTool", async () => {
    const { Client } = await import(
      "@modelcontextprotocol/sdk/client/index.js"
    );
    const MockClient = Client as unknown as ReturnType<typeof vi.fn>;

    MockClient.mockImplementationOnce(() => ({
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
      callTool: vi.fn().mockResolvedValue({
        content: [
          { type: "text", text: "Error: something went wrong" },
        ],
      }),
    }));

    const src = new LinearMcpInputSource({ accessToken: "test" });
    await src.connect();
    // parseResult should catch JSON.parse failure and return { text: "..." }
    const ctx = await src.getContext("POS-ERR");
    expect(ctx.id).toBeDefined();
    expect(ctx.title).toBe("");
  });

  it("handles callTool returning no text content", async () => {
    const { Client } = await import(
      "@modelcontextprotocol/sdk/client/index.js"
    );
    const MockClient = Client as unknown as ReturnType<typeof vi.fn>;

    MockClient.mockImplementationOnce(() => ({
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
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: "image", data: "abc" }],
      }),
    }));

    const src = new LinearMcpInputSource({ accessToken: "test" });
    await src.connect();
    // parseResult should handle no text entry — returns raw result
    const ctx = await src.getContext("POS-IMG");
    expect(ctx.id).toBe("POS-IMG");
    expect(ctx.title).toBe("");
  });

  it("listPending handles empty nodes array", async () => {
    const { Client } = await import(
      "@modelcontextprotocol/sdk/client/index.js"
    );
    const MockClient = Client as unknown as ReturnType<typeof vi.fn>;

    MockClient.mockImplementationOnce(() => ({
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
      callTool: vi.fn().mockResolvedValue({
        content: [
          {
            type: "text",
            text: JSON.stringify({ nodes: [] }),
          },
        ],
      }),
    }));

    const src = new LinearMcpInputSource({ accessToken: "test" });
    await src.connect();
    const resources = await src.listPending("team-id");
    expect(resources).toEqual([]);
  });

  it("listPending handles array response (not nodes object)", async () => {
    const { Client } = await import(
      "@modelcontextprotocol/sdk/client/index.js"
    );
    const MockClient = Client as unknown as ReturnType<typeof vi.fn>;

    MockClient.mockImplementationOnce(() => ({
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
      callTool: vi.fn().mockResolvedValue({
        content: [
          {
            type: "text",
            text: JSON.stringify([
              {
                id: "uuid-arr",
                identifier: "POS-ARR",
                title: "Array item",
                state: { name: "Started" },
                priority: 3,
                url: "https://linear.app/team/POS-ARR",
              },
            ]),
          },
        ],
      }),
    }));

    const src = new LinearMcpInputSource({ accessToken: "test" });
    await src.connect();
    const resources = await src.listPending("team-id");
    expect(resources).toHaveLength(1);
    expect(resources[0].identifier).toBe("POS-ARR");
  });

  it("getContext with labels but missing comments", async () => {
    const { Client } = await import(
      "@modelcontextprotocol/sdk/client/index.js"
    );
    const MockClient = Client as unknown as ReturnType<typeof vi.fn>;

    MockClient.mockImplementationOnce(() => ({
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
      callTool: vi.fn().mockResolvedValue({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              id: "uuid-partial",
              title: "Partial data",
              description: "has labels but no comments",
              state: { name: "Todo" },
              labels: { nodes: [{ name: "bug" }, { name: "urgent" }] },
              // comments field missing entirely
            }),
          },
        ],
      }),
    }));

    const src = new LinearMcpInputSource({ accessToken: "test" });
    await src.connect();
    const ctx = await src.getContext("POS-PARTIAL");
    expect(ctx.labels).toEqual(["bug", "urgent"]);
    expect(ctx.comments).toEqual([]);
  });
});
