import type {
  McpToolPlugin,
  McpServerConfig,
  HealthResult,
} from "@composio/ao-core";

/**
 * MCP plugin exposing PowerSync sync diagnostics to spawned agents.
 *
 * Requires a local PowerSync MCP server running at localhost:3748.
 * No onUnhealthy — PowerSync issues are software problems the agent can fix.
 */
export class PowerSyncPlugin implements McpToolPlugin {
  readonly name = "powersync-pos";
  readonly scope = "readwrite" as const;

  private readonly serverUrl: string;
  private readonly supabaseUrl: string;
  private readonly supabaseAnonKey: string;

  constructor(config: Record<string, unknown>) {
    this.serverUrl = String(config["serverUrl"] ?? "http://localhost:3748");
    this.supabaseUrl = String(config["supabaseUrl"] ?? "");
    this.supabaseAnonKey = String(config["supabaseAnonKey"] ?? "");
  }

  get url(): string {
    return `${this.serverUrl}/mcp`;
  }

  buildFlags(): string[] {
    return ["--mcp", `powersync-pos=${this.url}`];
  }

  buildMcpJson(): McpServerConfig {
    return {
      url: this.url,
      env: {
        SUPABASE_URL: this.supabaseUrl,
        SUPABASE_ANON_KEY: this.supabaseAnonKey,
      },
    };
  }

  async healthCheck(): Promise<HealthResult> {
    try {
      const res = await fetch(`${this.serverUrl}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      return {
        healthy: res.ok,
        message: res.ok ? undefined : "PowerSync MCP server not running",
      };
    } catch {
      return {
        healthy: false,
        message: "PowerSync MCP server not running",
      };
    }
  }
}
