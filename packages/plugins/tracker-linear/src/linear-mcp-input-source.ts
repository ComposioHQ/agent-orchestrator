import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  McpInputSource,
  AgentContext,
  AgentContextComment,
  Resource,
} from "@composio/ao-core";

export class LinearMcpInputSource implements McpInputSource {
  private client!: Client;
  private connected = false;
  private toolNames: Map<string, string> = new Map();

  constructor(private config: { accessToken: string }) {}

  async connect(): Promise<void> {
    this.client = new Client(
      { name: "agent-orchestrator", version: "1.0.0" },
      { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(
      new URL("https://mcp.linear.app/mcp"),
      {
        requestInit: {
          headers: { Authorization: `Bearer ${this.config.accessToken}` },
        },
      },
    );
    await this.client.connect(transport);
    this.connected = true;

    // Discover real tool names — do not assume
    const { tools } = await this.client.listTools();
    for (const tool of tools) {
      this.toolNames.set(tool.name, tool.name);
    }
  }

  async disconnect(): Promise<void> {
    if (this.connected) {
      await this.client.close();
      this.connected = false;
    }
  }

  async getContext(resourceId: string): Promise<AgentContext> {
    const result = await this.client.callTool({
      name: this.resolveTool("get_issue"),
      arguments: { issueId: resourceId },
    });
    const issue = this.parseResult(result);
    return {
      id: String(issue.id ?? resourceId),
      identifier: issue.identifier as string | undefined,
      title: String(issue.title ?? ""),
      description: String(issue.description ?? ""),
      status: String((issue.state as Record<string, unknown>)?.name ?? ""),
      priority: issue.priority as number | undefined,
      labels:
        (issue.labels as Record<string, unknown>)?.nodes
          ? ((issue.labels as Record<string, unknown>).nodes as Array<Record<string, unknown>>).map(
              (l: Record<string, unknown>) => String(l.name),
            )
          : [],
      comments:
        (issue.comments as Record<string, unknown>)?.nodes
          ? (
              (issue.comments as Record<string, unknown>).nodes as Array<Record<string, unknown>>
            ).map(
              (c: Record<string, unknown>): AgentContextComment => ({
                id: String(c.id),
                body: String(c.body),
                author: String((c.user as Record<string, unknown>)?.name ?? "unknown"),
                createdAt: String(c.createdAt),
              }),
            )
          : [],
      metadata: issue,
    };
  }

  async postUpdate(resourceId: string, body: string): Promise<void> {
    await this.client.callTool({
      name: this.resolveTool("create_comment"),
      arguments: { issueId: resourceId, body },
    });
  }

  async setStatus(resourceId: string, status: string): Promise<void> {
    await this.client.callTool({
      name: this.resolveTool("update_issue"),
      arguments: { issueId: resourceId, stateName: status },
    });
  }

  async listPending(projectKey: string): Promise<Resource[]> {
    const result = await this.client.callTool({
      name: this.resolveTool("list_issues"),
      arguments: {
        teamId: projectKey,
        states: ["backlog", "unstarted", "started"],
      },
    });
    const issues = this.parseResult(result);
    const arr = Array.isArray(issues)
      ? issues
      : ((issues as Record<string, unknown>)?.nodes as unknown[]) ?? [];
    return arr.map((item: unknown) => {
      const i = item as Record<string, unknown>;
      return {
        id: String(i.id),
        identifier: i.identifier as string | undefined,
        title: String(i.title ?? ""),
        status: String((i.state as Record<string, unknown>)?.name ?? ""),
        priority: i.priority as number | undefined,
        url: i.url as string | undefined,
      };
    });
  }

  /** Resolve tool name — use discovered name or fall back to assumed name */
  private resolveTool(assumed: string): string {
    // Try exact match first
    if (this.toolNames.has(assumed)) return assumed;
    // Try with linear_ prefix
    const prefixed = `linear_${assumed}`;
    if (this.toolNames.has(prefixed)) return prefixed;
    // Fall back to assumed name
    return assumed;
  }

  private parseResult(result: unknown): Record<string, unknown> {
    const r = result as Record<string, unknown>;
    const content = r?.content as Array<Record<string, unknown>> | undefined;
    const text = content?.find(
      (c: Record<string, unknown>) => c.type === "text",
    )?.text;
    if (typeof text !== "string") return r;
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { text } as Record<string, unknown>;
    }
  }
}
