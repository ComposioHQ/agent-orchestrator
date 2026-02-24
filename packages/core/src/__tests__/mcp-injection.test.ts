import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { injectMcpConfig, cleanupMcpConfig } from "../mcp-injection.js";
import {
  resolveMcpPlugins,
  registerMcpPlugin,
  UrlMcpToolPlugin,
} from "../resolve-mcp-plugins.js";
import type { McpToolPlugin, McpServerConfig, HealthResult, ReactionType } from "../types.js";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

function makeTmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), "ao-test-"));
}

function makePlugin(overrides: Partial<McpToolPlugin> & { name: string }): McpToolPlugin {
  return {
    scope: "readwrite" as const,
    buildFlags: () => [],
    buildMcpJson: (): McpServerConfig => ({ url: "http://localhost/mcp" }),
    ...overrides,
  };
}

describe("injectMcpConfig", () => {
  it("returns empty result for no plugins", async () => {
    const session = { worktreePath: "/tmp/test", metadata: {} };
    const result = await injectMcpConfig(session, []);

    expect(result.mcpJsonPath).toBe("");
    expect(result.failedPlugins).toEqual([]);
    expect(result.blockedByHardware).toBe(false);
  });

  it("writes .mcp.json with correct content for healthy plugins", async () => {
    const dir = makeTmpDir();
    const session = { worktreePath: dir, metadata: {} };
    const plugin = makePlugin({
      name: "test-mcp",
      buildMcpJson: () => ({ url: "http://localhost:3747/mcp" }),
    });

    const result = await injectMcpConfig(session, [plugin]);

    expect(result.mcpJsonPath).toBe(path.join(dir, ".mcp.json"));
    expect(result.blockedByHardware).toBe(false);

    const content = JSON.parse(await fs.readFile(result.mcpJsonPath, "utf-8"));
    expect(content.mcpServers["test-mcp"]).toEqual({
      url: "http://localhost:3747/mcp",
    });

    // Cleanup
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("excludes unhealthy plugins but still writes for others", async () => {
    const dir = makeTmpDir();
    const session = { worktreePath: dir, metadata: {} };
    const healthy = makePlugin({
      name: "healthy-plugin",
      buildMcpJson: () => ({ url: "http://healthy/mcp" }),
    });
    const unhealthy = makePlugin({
      name: "sick-plugin",
      healthCheck: async (): Promise<HealthResult> => ({
        healthy: false,
        message: "Server down",
      }),
    });

    const result = await injectMcpConfig(session, [healthy, unhealthy]);

    expect(result.failedPlugins).toHaveLength(1);
    expect(result.failedPlugins[0].name).toBe("sick-plugin");
    expect(result.blockedByHardware).toBe(false);

    const content = JSON.parse(await fs.readFile(result.mcpJsonPath, "utf-8"));
    expect(content.mcpServers["healthy-plugin"]).toBeDefined();
    expect(content.mcpServers["sick-plugin"]).toBeUndefined();

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns blockedByHardware when hardware plugin fails", async () => {
    const session = { worktreePath: "/tmp/test", metadata: {} };
    const hwPlugin = makePlugin({
      name: "dejavoo",
      healthCheck: async (): Promise<HealthResult> => ({
        healthy: false,
        message: "Terminal offline",
      }),
      onUnhealthy: (): ReactionType => "hardware-test-required",
    });

    const result = await injectMcpConfig(session, [hwPlugin]);

    expect(result.blockedByHardware).toBe(true);
    expect(result.hardwareReaction).toBe("hardware-test-required");
    expect(result.mcpJsonPath).toBe("");
  });

  it("runs health checks in parallel", async () => {
    const dir = makeTmpDir();
    const session = { worktreePath: dir, metadata: {} };
    const startTimes: number[] = [];

    const makeDelayPlugin = (name: string, delayMs: number): McpToolPlugin =>
      makePlugin({
        name,
        healthCheck: async (): Promise<HealthResult> => {
          startTimes.push(Date.now());
          await new Promise((r) => setTimeout(r, delayMs));
          return { healthy: true };
        },
      });

    const plugins = [
      makeDelayPlugin("p1", 50),
      makeDelayPlugin("p2", 50),
      makeDelayPlugin("p3", 50),
    ];

    const start = Date.now();
    await injectMcpConfig(session, plugins);
    const elapsed = Date.now() - start;

    // If sequential, would be ~150ms. Parallel should be ~50-80ms.
    expect(elapsed).toBeLessThan(120);

    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("cleanupMcpConfig", () => {
  it("removes the .mcp.json file", async () => {
    const dir = makeTmpDir();
    const mcpJsonPath = path.join(dir, ".mcp.json");
    await fs.writeFile(mcpJsonPath, "{}", "utf-8");

    const session = { worktreePath: dir, metadata: { mcpJsonPath } };
    await cleanupMcpConfig(session);

    await expect(fs.access(mcpJsonPath)).rejects.toThrow();

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("no-ops without throwing when no path set", async () => {
    const session = { worktreePath: "/tmp/test", metadata: {} };
    await expect(cleanupMcpConfig(session)).resolves.toBeUndefined();
  });

  it("no-ops without throwing when metadata is undefined", async () => {
    const session = { worktreePath: "/tmp/test" };
    await expect(cleanupMcpConfig(session)).resolves.toBeUndefined();
  });
});

describe("UrlMcpToolPlugin", () => {
  it("buildMcpJson returns url config", () => {
    const plugin = new UrlMcpToolPlugin({
      name: "test",
      url: "http://localhost:3747/mcp",
      scope: "readwrite",
    });
    expect(plugin.buildMcpJson()).toEqual({ url: "http://localhost:3747/mcp" });
  });

  it("buildMcpJson includes env when provided", () => {
    const plugin = new UrlMcpToolPlugin({
      name: "test",
      url: "http://localhost/mcp",
      scope: "readonly",
      env: { API_KEY: "secret" },
    });
    expect(plugin.buildMcpJson()).toEqual({
      url: "http://localhost/mcp",
      env: { API_KEY: "secret" },
    });
  });

  it("buildFlags returns --mcp flag", () => {
    const plugin = new UrlMcpToolPlugin({
      name: "test",
      url: "http://localhost/mcp",
      scope: "readwrite",
    });
    expect(plugin.buildFlags()).toEqual(["--mcp", "test=http://localhost/mcp"]);
  });
});

describe("resolveMcpPlugins", () => {
  it("throws for unknown plugin name", () => {
    expect(() =>
      resolveMcpPlugins([{ plugin: "NonexistentPlugin" }]),
    ).toThrow(/Unknown MCP plugin/);
  });

  it("creates UrlMcpToolPlugin for inline name+url entries", () => {
    const plugins = resolveMcpPlugins([
      { name: "test", url: "http://localhost/mcp" },
    ]);
    expect(plugins).toHaveLength(1);
    expect(plugins[0].name).toBe("test");
  });

  it("throws for entry with neither plugin nor name+url", () => {
    expect(() => resolveMcpPlugins([{ scope: "readonly" }])).toThrow(
      /must have/,
    );
  });
});
