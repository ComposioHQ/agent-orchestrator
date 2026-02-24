/**
 * Tests for McpToolPlugin interface and MCP config schema validation.
 */

import { describe, it, expect } from "vitest";
import type {
  McpToolPlugin,
  McpServerConfig,
  HealthResult,
  ReactionType,
  McpEntry,
} from "../types.js";
import { validateConfig } from "../config.js";

// ---------- Type-level compile checks ----------

describe("McpToolPlugin interface", () => {
  it("compiles with a conforming implementation", () => {
    const _check: McpToolPlugin = {
      name: "test-plugin",
      url: "http://localhost:3747/mcp",
      scope: "readwrite" as const,
      buildFlags: () => ["--mcp", "test=http://localhost:3747/mcp"],
      buildMcpJson: (): McpServerConfig => ({
        url: "http://localhost:3747/mcp",
      }),
    };
    expect(_check.name).toBe("test-plugin");
  });

  it("compiles with optional healthCheck and onUnhealthy", () => {
    const _check: McpToolPlugin = {
      name: "hardware-plugin",
      scope: "readwrite" as const,
      buildFlags: () => [],
      buildMcpJson: (): McpServerConfig => ({ url: "http://localhost/mcp" }),
      healthCheck: async (): Promise<HealthResult> => ({
        healthy: true,
        latencyMs: 42,
        message: "OK",
      }),
      onUnhealthy: (): ReactionType => "hardware-test-required",
    };
    expect(_check.healthCheck).toBeDefined();
    expect(_check.onUnhealthy?.()).toBe("hardware-test-required");
  });

  it("compiles with command-based MCP server config", () => {
    const _check: McpToolPlugin = {
      name: "local-tool",
      command: "npx",
      args: ["-y", "@some/mcp-server"],
      scope: "readonly" as const,
      env: { API_KEY: "test" },
      buildFlags: () => [],
      buildMcpJson: (): McpServerConfig => ({
        command: "npx",
        args: ["-y", "@some/mcp-server"],
        env: { API_KEY: "test" },
      }),
    };
    expect(_check.command).toBe("npx");
  });
});

describe("McpServerConfig", () => {
  it("supports URL-based config", () => {
    const cfg: McpServerConfig = { url: "http://localhost:3747/mcp" };
    expect(cfg.url).toBe("http://localhost:3747/mcp");
  });

  it("supports command-based config", () => {
    const cfg: McpServerConfig = {
      command: "node",
      args: ["server.js"],
      env: { PORT: "3748" },
    };
    expect(cfg.command).toBe("node");
  });
});

describe("HealthResult", () => {
  it("supports minimal healthy result", () => {
    const result: HealthResult = { healthy: true };
    expect(result.healthy).toBe(true);
  });

  it("supports full unhealthy result", () => {
    const result: HealthResult = {
      healthy: false,
      latencyMs: 2000,
      message: "Bridge unreachable",
    };
    expect(result.message).toContain("unreachable");
  });
});

// ---------- Config schema validation ----------

function makeConfig(mcpEntries: unknown[]) {
  return {
    projects: {
      testproj: {
        path: "/repos/test",
        repo: "org/test",
        defaultBranch: "main",
        mcp: mcpEntries,
      },
    },
  };
}

describe("MCP config schema validation", () => {
  it("mcp: [] is valid", () => {
    expect(() => validateConfig(makeConfig([]))).not.toThrow();
  });

  it("mcp with name and url is valid", () => {
    expect(() =>
      validateConfig(
        makeConfig([{ name: "test", url: "http://localhost:3747/mcp" }]),
      ),
    ).not.toThrow();
  });

  it("mcp with plugin name is valid", () => {
    expect(() =>
      validateConfig(makeConfig([{ plugin: "DejavooPlugin" }])),
    ).not.toThrow();
  });

  it("mcp with full inline config is valid", () => {
    expect(() =>
      validateConfig(
        makeConfig([
          {
            name: "supabase",
            url: "https://mcp.supabase.com/mcp",
            scope: "readonly",
            env: { SUPABASE_ACCESS_TOKEN: "token123" },
          },
        ]),
      ),
    ).not.toThrow();
  });

  it("mcp with invalid url fails", () => {
    expect(() =>
      validateConfig(makeConfig([{ name: "x", url: "not-a-url" }])),
    ).toThrow();
  });

  it("mcp with invalid scope fails", () => {
    expect(() =>
      validateConfig(
        makeConfig([
          { name: "x", url: "http://localhost:3747/mcp", scope: "invalid" },
        ]),
      ),
    ).toThrow();
  });

  it("mcp entry with neither plugin nor name+url fails", () => {
    expect(() => validateConfig(makeConfig([{ scope: "readonly" }]))).toThrow();
  });

  it("mcp entry with name but no url fails", () => {
    expect(() => validateConfig(makeConfig([{ name: "test" }]))).toThrow();
  });

  it("mcp absent from project config is valid", () => {
    const config = {
      projects: {
        testproj: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
        },
      },
    };
    expect(() => validateConfig(config)).not.toThrow();
  });

  it("hardware-test-required reaction is accepted", () => {
    const config = {
      projects: {
        testproj: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
        },
      },
      reactions: {
        "hardware-test-required": {
          auto: false,
          action: "queue-for-hardware",
        },
      },
    };
    expect(() => validateConfig(config)).not.toThrow();
  });
});
