import { describe, it, expect, vi, afterEach } from "vitest";
import { DejavooPlugin } from "../dejavoo-plugin.js";
import { PowerSyncPlugin } from "../powersync-plugin.js";
import { SupabasePOSPlugin } from "../supabase-pos-plugin.js";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

afterEach(() => {
  vi.clearAllMocks();
});

describe("DejavooPlugin", () => {
  it("uses default bridge URL", () => {
    const plugin = new DejavooPlugin();
    expect(plugin.url).toBe("http://localhost:3747/mcp");
  });

  it("accepts custom bridge URL", () => {
    const plugin = new DejavooPlugin({ bridgeUrl: "http://10.0.0.5:3747" });
    expect(plugin.url).toBe("http://10.0.0.5:3747/mcp");
  });

  it("buildMcpJson returns url config", () => {
    const plugin = new DejavooPlugin();
    expect(plugin.buildMcpJson()).toEqual({ url: "http://localhost:3747/mcp" });
  });

  it("buildFlags returns --mcp flag", () => {
    const plugin = new DejavooPlugin();
    expect(plugin.buildFlags()).toEqual([
      "--mcp",
      "dejavoo-pos=http://localhost:3747/mcp",
    ]);
  });

  it("healthCheck returns healthy when bridge returns 200", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({}),
    });
    const plugin = new DejavooPlugin();
    const result = await plugin.healthCheck();
    expect(result.healthy).toBe(true);
    expect(result.latencyMs).toBeDefined();
  });

  it("healthCheck returns unhealthy when bridge unreachable", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const plugin = new DejavooPlugin();
    const result = await plugin.healthCheck();
    expect(result.healthy).toBe(false);
    expect(result.message).toContain("unreachable");
  });

  it("healthCheck returns unhealthy for non-200 response", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });
    const plugin = new DejavooPlugin();
    const result = await plugin.healthCheck();
    expect(result.healthy).toBe(false);
    expect(result.message).toContain("503");
  });

  it("onUnhealthy returns hardware-test-required", () => {
    const plugin = new DejavooPlugin();
    expect(plugin.onUnhealthy()).toBe("hardware-test-required");
  });

  it("scope is readwrite", () => {
    const plugin = new DejavooPlugin();
    expect(plugin.scope).toBe("readwrite");
  });
});

describe("PowerSyncPlugin", () => {
  it("uses default server URL", () => {
    const plugin = new PowerSyncPlugin({
      supabaseUrl: "https://example.supabase.co",
      supabaseAnonKey: "key123",
    });
    expect(plugin.url).toBe("http://localhost:3748/mcp");
  });

  it("buildMcpJson includes env vars", () => {
    const plugin = new PowerSyncPlugin({
      supabaseUrl: "https://example.supabase.co",
      supabaseAnonKey: "key123",
    });
    const config = plugin.buildMcpJson();
    expect(config.url).toBe("http://localhost:3748/mcp");
    expect(config.env).toEqual({
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_ANON_KEY: "key123",
    });
  });

  it("healthCheck returns healthy when server returns 200", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });
    const plugin = new PowerSyncPlugin({
      supabaseUrl: "https://example.supabase.co",
      supabaseAnonKey: "key123",
    });
    const result = await plugin.healthCheck();
    expect(result.healthy).toBe(true);
  });

  it("healthCheck returns unhealthy when server not running", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const plugin = new PowerSyncPlugin({
      supabaseUrl: "https://example.supabase.co",
      supabaseAnonKey: "key123",
    });
    const result = await plugin.healthCheck();
    expect(result.healthy).toBe(false);
    expect(result.message).toBe("PowerSync MCP server not running");
  });

  it("does NOT have onUnhealthy (software plugin)", () => {
    const plugin = new PowerSyncPlugin({
      supabaseUrl: "https://x.supabase.co",
      supabaseAnonKey: "k",
    });
    expect(
      (plugin as Record<string, unknown>)["onUnhealthy"],
    ).toBeUndefined();
  });

  it("scope is readwrite", () => {
    const plugin = new PowerSyncPlugin({
      supabaseUrl: "https://x.supabase.co",
      supabaseAnonKey: "k",
    });
    expect(plugin.scope).toBe("readwrite");
  });
});

describe("SupabasePOSPlugin", () => {
  it("scope is readonly", () => {
    const plugin = new SupabasePOSPlugin({
      projectRef: "abc123",
      accessToken: "token",
    });
    expect(plugin.scope).toBe("readonly");
  });

  it("URL contains project_ref and read_only=true", () => {
    const plugin = new SupabasePOSPlugin({
      projectRef: "abc123",
      accessToken: "token",
    });
    expect(plugin.url).toContain("project_ref=abc123");
    expect(plugin.url).toContain("read_only=true");
  });

  it("buildMcpJson includes access token in env", () => {
    const plugin = new SupabasePOSPlugin({
      projectRef: "abc123",
      accessToken: "my-token",
    });
    const config = plugin.buildMcpJson();
    expect(config.env).toEqual({
      SUPABASE_ACCESS_TOKEN: "my-token",
    });
  });

  it("healthCheck succeeds for non-500 response", async () => {
    mockFetch.mockResolvedValueOnce({ status: 200 });
    const plugin = new SupabasePOSPlugin({
      projectRef: "abc123",
      accessToken: "token",
    });
    const result = await plugin.healthCheck();
    expect(result.healthy).toBe(true);
  });

  it("healthCheck fails for 500 response", async () => {
    mockFetch.mockResolvedValueOnce({ status: 500 });
    const plugin = new SupabasePOSPlugin({
      projectRef: "abc123",
      accessToken: "token",
    });
    const result = await plugin.healthCheck();
    expect(result.healthy).toBe(false);
  });

  it("healthCheck fails when unreachable", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));
    const plugin = new SupabasePOSPlugin({
      projectRef: "abc123",
      accessToken: "token",
    });
    const result = await plugin.healthCheck();
    expect(result.healthy).toBe(false);
    expect(result.message).toContain("mcp.supabase.com");
  });
});
