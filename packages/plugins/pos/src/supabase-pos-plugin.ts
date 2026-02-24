import type {
  McpToolPlugin,
  McpServerConfig,
  HealthResult,
} from "@composio/ao-core";

/**
 * MCP plugin for Supabase — scoped to paradise-pos project in read-only mode.
 *
 * Uses the official Supabase hosted MCP server (mcp.supabase.com).
 * Read-only enforced via read_only=true query param.
 */
export class SupabasePOSPlugin implements McpToolPlugin {
  readonly name = "supabase-pos";
  readonly scope = "readonly" as const;

  private readonly projectRef: string;
  private readonly accessToken: string;

  constructor(config: Record<string, unknown>) {
    this.projectRef = String(config["projectRef"] ?? "");
    this.accessToken = String(config["accessToken"] ?? "");
  }

  get url(): string {
    return `https://mcp.supabase.com/mcp?project_ref=${this.projectRef}&read_only=true`;
  }

  buildFlags(): string[] {
    return ["--mcp", `supabase-pos=${this.url}`];
  }

  buildMcpJson(): McpServerConfig {
    return {
      url: this.url,
      env: { SUPABASE_ACCESS_TOKEN: this.accessToken },
    };
  }

  async healthCheck(): Promise<HealthResult> {
    try {
      const res = await fetch("https://mcp.supabase.com/", {
        signal: AbortSignal.timeout(3000),
      });
      return { healthy: res.status < 500 };
    } catch (e) {
      return {
        healthy: false,
        message: `Cannot reach mcp.supabase.com: ${(e as Error).message}`,
      };
    }
  }
}
