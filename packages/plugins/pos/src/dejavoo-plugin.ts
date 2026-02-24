import type {
  McpToolPlugin,
  McpServerConfig,
  HealthResult,
  ReactionType,
} from "@composio/ao-core";

/**
 * MCP plugin for the Dejavoo DVPayLite payment terminal.
 *
 * Requires the local DVPayLite MCP bridge server running at localhost:3747.
 * If the bridge is unreachable (terminal offline, bridge not started),
 * this plugin routes to hardware-test-required instead of letting the
 * agent spin on tests it cannot run.
 */
export class DejavooPlugin implements McpToolPlugin {
  readonly name = "dejavoo-pos";
  readonly scope = "readwrite" as const;

  private readonly bridgeUrl: string;

  constructor(config: Record<string, unknown> = {}) {
    this.bridgeUrl = String(config["bridgeUrl"] ?? "http://localhost:3747");
  }

  get url(): string {
    return `${this.bridgeUrl}/mcp`;
  }

  buildFlags(): string[] {
    return ["--mcp", `dejavoo-pos=${this.url}`];
  }

  buildMcpJson(): McpServerConfig {
    return { url: this.url };
  }

  async healthCheck(): Promise<HealthResult> {
    const start = Date.now();
    try {
      const res = await fetch(`${this.bridgeUrl}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) {
        return { healthy: false, message: `Bridge HTTP ${res.status}` };
      }
      const data = (await res.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      return {
        healthy: true,
        latencyMs: Date.now() - start,
        message: `Bridge OK${data["pending"] ? `, ${data["pending"]} pending` : ""}`,
      };
    } catch (e) {
      return {
        healthy: false,
        message: `DVPayLite bridge unreachable: ${(e as Error).message}`,
      };
    }
  }

  onUnhealthy(): ReactionType {
    return "hardware-test-required";
  }
}
