import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpInputSource, AgentContext, Resource } from "./types.js";

export interface McpToolMap {
  getContext: string;
  getContextIdArg: string;

  postUpdate: string;
  postUpdateIdArg: string;
  postUpdateBodyArg: string;

  setStatus: string;
  setStatusIdArg: string;
  setStatusValueArg: string;

  listPending: string;
  listPendingProjectArg: string;

  /** Dot-path expressions to extract AgentContext fields from tool result */
  fields: {
    id: string;
    title: string;
    description: string;
    status: string;
    labels?: string;
    comments?: string;
  };
}

export interface GenericMcpConfig {
  url: string;
  auth?: { type: "bearer"; token: string };
  toolMap: McpToolMap;
}

export class GenericMcpInputSource implements McpInputSource {
  private client!: Client;

  constructor(private config: GenericMcpConfig) {}

  async connect(): Promise<void> {
    this.client = new Client(
      { name: "agent-orchestrator", version: "1.0.0" },
    );
    const headers: Record<string, string> = {};
    if (this.config.auth?.type === "bearer") {
      headers["Authorization"] = `Bearer ${this.config.auth.token}`;
    }
    const transport = new StreamableHTTPClientTransport(
      new URL(this.config.url),
      { requestInit: { headers } },
    );
    await this.client.connect(transport);
    await this.validateToolMap();
  }

  async disconnect(): Promise<void> {
    await this.client.close();
  }

  /** Validate all mapped tools exist — fail fast with clear error */
  private async validateToolMap(): Promise<void> {
    const { tools } = await this.client.listTools();
    const available = new Set(tools.map((t) => t.name));
    const tm = this.config.toolMap;
    const required = [tm.getContext, tm.postUpdate, tm.setStatus, tm.listPending];
    const missing = required.filter((n) => !available.has(n));
    if (missing.length > 0) {
      throw new Error(
        `GenericMcpInputSource: server at ${this.config.url} missing tools: ${missing.join(", ")}. ` +
          `Available: ${[...available].join(", ")}`,
      );
    }
  }

  async getContext(resourceId: string): Promise<AgentContext> {
    const tm = this.config.toolMap;
    const result = await this.client.callTool({
      name: tm.getContext,
      arguments: { [tm.getContextIdArg]: resourceId },
    });
    const data = this.parseResult(result);
    return {
      id: String(this.resolvePath(data, tm.fields.id) ?? resourceId),
      title: String(this.resolvePath(data, tm.fields.title) ?? ""),
      description: String(this.resolvePath(data, tm.fields.description) ?? ""),
      status: String(this.resolvePath(data, tm.fields.status) ?? ""),
      labels: tm.fields.labels
        ? ((this.resolvePath(data, tm.fields.labels) as string[]) ?? [])
        : [],
      comments: tm.fields.comments
        ? ((this.resolvePath(data, tm.fields.comments) as Array<Record<string, unknown>>) ?? []).map(
            (c) => ({
              id: String(c["id"] ?? ""),
              body: String(c["body"] ?? ""),
              author: String(c["author"] ?? "unknown"),
              createdAt: String(c["createdAt"] ?? ""),
            }),
          )
        : [],
      metadata: data,
    };
  }

  async postUpdate(resourceId: string, body: string): Promise<void> {
    const tm = this.config.toolMap;
    await this.client.callTool({
      name: tm.postUpdate,
      arguments: {
        [tm.postUpdateIdArg]: resourceId,
        [tm.postUpdateBodyArg]: body,
      },
    });
  }

  async setStatus(resourceId: string, status: string): Promise<void> {
    const tm = this.config.toolMap;
    await this.client.callTool({
      name: tm.setStatus,
      arguments: {
        [tm.setStatusIdArg]: resourceId,
        [tm.setStatusValueArg]: status,
      },
    });
  }

  async listPending(projectKey: string): Promise<Resource[]> {
    const tm = this.config.toolMap;
    const result = await this.client.callTool({
      name: tm.listPending,
      arguments: { [tm.listPendingProjectArg]: projectKey },
    });
    const data = this.parseResult(result);
    const items = Array.isArray(data)
      ? data
      : ((data as Record<string, unknown>)?.items as unknown[]) ?? [data];
    return items.map((item: unknown) => {
      const i = item as Record<string, unknown>;
      return {
        id: String(this.resolvePath(i, tm.fields.id) ?? i["id"]),
        title: String(this.resolvePath(i, tm.fields.title) ?? ""),
        status: String(this.resolvePath(i, tm.fields.status) ?? ""),
      };
    });
  }

  /** Resolve dot-path: "a.b.items[0].name" */
  resolvePath(obj: unknown, expr: string): unknown {
    return expr.split(".").reduce((cur: unknown, key: string) => {
      if (cur == null) return undefined;
      const record = cur as Record<string, unknown>;
      const m = key.match(/^(.+)\[(\d+)\]$/);
      if (m) {
        const arr = record[m[1]] as unknown[] | undefined;
        return arr?.[Number(m[2])];
      }
      return record[key];
    }, obj);
  }

  private parseResult(result: unknown): Record<string, unknown> {
    const r = result as Record<string, unknown>;
    const content = r?.content as Array<Record<string, unknown>> | undefined;
    const text = content?.find((c) => c.type === "text")?.text;
    if (typeof text !== "string") return r;
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { text } as Record<string, unknown>;
    }
  }
}
