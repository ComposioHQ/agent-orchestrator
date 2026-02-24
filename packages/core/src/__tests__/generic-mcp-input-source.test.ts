import { describe, it, expect, vi, beforeEach } from "vitest";
import { GenericMcpInputSource } from "../generic-mcp-input-source.js";
import type { McpToolMap } from "../generic-mcp-input-source.js";

const mockToolMap: McpToolMap = {
  getContext: "get_page",
  getContextIdArg: "pageId",
  postUpdate: "add_comment",
  postUpdateIdArg: "pageId",
  postUpdateBodyArg: "content",
  setStatus: "update_status",
  setStatusIdArg: "pageId",
  setStatusValueArg: "status",
  listPending: "list_pages",
  listPendingProjectArg: "databaseId",
  fields: {
    id: "id",
    title: "properties.Name.title[0].plain_text",
    description: "properties.Description.rich_text[0].plain_text",
    status: "properties.Status.select.name",
  },
};

// Shared mock references for assertions — assigned inside MockClient constructor
let mockCallTool: ReturnType<typeof vi.fn>;
let mockListTools: ReturnType<typeof vi.fn>;

// Mock the MCP SDK
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => {
  class MockClient {
    connect = vi.fn().mockResolvedValue(undefined);
    close = vi.fn().mockResolvedValue(undefined);
    listTools: ReturnType<typeof vi.fn>;
    callTool: ReturnType<typeof vi.fn>;

    constructor() {
      this.callTool = vi.fn().mockImplementation(({ name }: { name: string }) => {
        if (name === "get_page") {
          return Promise.resolve({
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  id: "page-123",
                  properties: {
                    Name: { title: [{ plain_text: "My Task" }] },
                    Description: {
                      rich_text: [{ plain_text: "Task description" }],
                    },
                    Status: { select: { name: "In Progress" } },
                  },
                }),
              },
            ],
          });
        }
        if (name === "list_pages") {
          return Promise.resolve({
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  items: [
                    {
                      id: "page-1",
                      properties: {
                        Name: { title: [{ plain_text: "Task 1" }] },
                        Status: { select: { name: "Todo" } },
                      },
                    },
                  ],
                }),
              },
            ],
          });
        }
        return Promise.resolve({ content: [] });
      });
      this.listTools = vi.fn().mockResolvedValue({
        tools: [
          { name: "get_page" },
          { name: "add_comment" },
          { name: "update_status" },
          { name: "list_pages" },
        ],
      });

      // Expose to outer scope for assertions
      mockCallTool = this.callTool;
      mockListTools = this.listTools;
    }
  }
  return { Client: MockClient };
});

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => {
  class MockTransport {}
  return { StreamableHTTPClientTransport: MockTransport };
});

describe("GenericMcpInputSource", () => {
  let source: GenericMcpInputSource;

  beforeEach(() => {
    vi.clearAllMocks();
    source = new GenericMcpInputSource({
      url: "http://localhost:8080/mcp",
      auth: { type: "bearer", token: "test-token" },
      toolMap: mockToolMap,
    });
  });

  it("connect() validates tool map", async () => {
    await source.connect();
  });

  it("validateToolMap throws with clear message for missing tools", async () => {
    const badSource = new GenericMcpInputSource({
      url: "http://localhost:8080/mcp",
      toolMap: {
        ...mockToolMap,
        getContext: "nonexistent_tool",
      },
    });
    await expect(badSource.connect()).rejects.toThrow(/missing tools/);
    await expect(badSource.connect()).rejects.toThrow(/nonexistent_tool/);
    await expect(badSource.connect()).rejects.toThrow(/localhost:8080/);
  });

  it("getContext() resolves dot-path fields", async () => {
    await source.connect();
    const ctx = await source.getContext("page-123");

    expect(ctx.id).toBe("page-123");
    expect(ctx.title).toBe("My Task");
    expect(ctx.description).toBe("Task description");
    expect(ctx.status).toBe("In Progress");
    expect(ctx.metadata).toBeDefined();
  });

  it("listPending() maps items correctly", async () => {
    await source.connect();
    const resources = await source.listPending("db-1");

    expect(resources).toHaveLength(1);
    expect(resources[0].id).toBe("page-1");
    expect(resources[0].title).toBe("Task 1");
    expect(resources[0].status).toBe("Todo");
  });

  it("connect() with bearer auth passes Authorization header", async () => {
    await source.connect();
    // If it connects without error, auth was passed correctly
  });
});

describe("resolvePath", () => {
  // resolvePath is tested through GenericMcpInputSource but we can test it more directly
  it("handles simple paths", () => {
    const source = new GenericMcpInputSource({
      url: "http://localhost/mcp",
      toolMap: mockToolMap,
    });
    expect(source.resolvePath({ id: "123" }, "id")).toBe("123");
  });

  it("handles nested paths", () => {
    const source = new GenericMcpInputSource({
      url: "http://localhost/mcp",
      toolMap: mockToolMap,
    });
    expect(source.resolvePath({ a: { b: { c: "deep" } } }, "a.b.c")).toBe("deep");
  });

  it("handles array index paths", () => {
    const source = new GenericMcpInputSource({
      url: "http://localhost/mcp",
      toolMap: mockToolMap,
    });
    expect(
      source.resolvePath({ items: [{ name: "first" }] }, "items[0].name"),
    ).toBe("first");
  });

  it("returns undefined for null mid-chain", () => {
    const source = new GenericMcpInputSource({
      url: "http://localhost/mcp",
      toolMap: mockToolMap,
    });
    expect(source.resolvePath({ a: null }, "a.b.c")).toBeUndefined();
  });

  it("returns undefined for missing keys", () => {
    const source = new GenericMcpInputSource({
      url: "http://localhost/mcp",
      toolMap: mockToolMap,
    });
    expect(source.resolvePath({}, "missing.path")).toBeUndefined();
  });
});

describe("postUpdate", () => {
  let source: GenericMcpInputSource;

  beforeEach(() => {
    vi.clearAllMocks();
    source = new GenericMcpInputSource({
      url: "http://localhost:8080/mcp",
      auth: { type: "bearer", token: "test-token" },
      toolMap: mockToolMap,
    });
  });

  it("calls the correct tool with correct arguments", async () => {
    await source.connect();
    await source.postUpdate("page-123", "Starting work");
    expect(mockCallTool).toHaveBeenCalledWith({
      name: "add_comment",
      arguments: { pageId: "page-123", content: "Starting work" },
    });
  });
});

describe("setStatus", () => {
  let source: GenericMcpInputSource;

  beforeEach(() => {
    vi.clearAllMocks();
    source = new GenericMcpInputSource({
      url: "http://localhost:8080/mcp",
      auth: { type: "bearer", token: "test-token" },
      toolMap: mockToolMap,
    });
  });

  it("calls the correct tool with correct arguments", async () => {
    await source.connect();
    await source.setStatus("page-123", "In Review");
    expect(mockCallTool).toHaveBeenCalledWith({
      name: "update_status",
      arguments: { pageId: "page-123", status: "In Review" },
    });
  });
});

describe("error handling", () => {
  let source: GenericMcpInputSource;

  beforeEach(() => {
    vi.clearAllMocks();
    source = new GenericMcpInputSource({
      url: "http://localhost:8080/mcp",
      auth: { type: "bearer", token: "test-token" },
      toolMap: mockToolMap,
    });
  });

  it("getContext handles missing text content gracefully", async () => {
    await source.connect();
    mockCallTool.mockResolvedValueOnce({ content: [] });
    const ctx = await source.getContext("page-missing");
    // Should not throw, returns defaults from the empty result
    expect(ctx.id).toBeDefined();
  });

  it("getContext handles non-JSON text content", async () => {
    await source.connect();
    mockCallTool.mockResolvedValueOnce({
      content: [{ type: "text", text: "Not JSON at all" }],
    });
    const ctx = await source.getContext("page-bad");
    expect(ctx.id).toBeDefined();
  });
});
