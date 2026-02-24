import type {
  McpToolPlugin,
  McpServerConfig,
  HealthResult,
} from "./types.js";

const pluginCatalog = new Map<
  string,
  new (config: Record<string, unknown>) => McpToolPlugin
>();

export function registerMcpPlugin(
  name: string,
  cls: new (config: Record<string, unknown>) => McpToolPlugin,
): void {
  pluginCatalog.set(name, cls);
}

export function getRegisteredMcpPlugin(
  name: string,
): (new (config: Record<string, unknown>) => McpToolPlugin) | undefined {
  return pluginCatalog.get(name);
}

export function resolveMcpPlugins(
  entries: Array<Record<string, unknown>>,
): McpToolPlugin[] {
  return entries.map((entry) => {
    if (entry["plugin"]) {
      const pluginName = String(entry["plugin"]);
      const Cls = pluginCatalog.get(pluginName);
      if (!Cls) {
        throw new Error(
          `Unknown MCP plugin: "${pluginName}". Register it with registerMcpPlugin().`,
        );
      }
      return new Cls(entry);
    }
    if (entry["name"] && entry["url"]) {
      return new UrlMcpToolPlugin({
        name: String(entry["name"]),
        url: String(entry["url"]),
        scope: (entry["scope"] as "readonly" | "readwrite") ?? "readwrite",
        env: entry["env"] as Record<string, string> | undefined,
      });
    }
    throw new Error("MCP entry must have 'plugin' or both 'name' and 'url'");
  });
}

/** Default implementation for simple HTTP MCP servers */
class UrlMcpToolPlugin implements McpToolPlugin {
  readonly name: string;
  readonly url: string;
  readonly scope: "readonly" | "readwrite";
  readonly env?: Record<string, string>;

  constructor(cfg: {
    name: string;
    url: string;
    scope: "readonly" | "readwrite";
    env?: Record<string, string>;
  }) {
    this.name = cfg.name;
    this.url = cfg.url;
    this.scope = cfg.scope;
    this.env = cfg.env;
  }

  buildFlags(): string[] {
    return ["--mcp", `${this.name}=${this.url}`];
  }

  buildMcpJson(): McpServerConfig {
    return {
      url: this.url,
      ...(this.env ? { env: this.env } : {}),
    };
  }

  async healthCheck(): Promise<HealthResult> {
    try {
      const healthUrl = this.url.replace(/\/mcp$/, "/health");
      const res = await fetch(healthUrl, {
        signal: AbortSignal.timeout(3000),
      });
      return { healthy: res.ok };
    } catch (e) {
      return {
        healthy: false,
        message: `Cannot reach ${this.url}: ${(e as Error).message}`,
      };
    }
  }
}

export { UrlMcpToolPlugin };
