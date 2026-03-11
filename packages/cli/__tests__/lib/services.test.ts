import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { OrchestratorConfig } from "@composio/ao-core";
import { probeManagedServices, resolveServicePorts } from "../../src/lib/services.js";

interface TestServer {
  server: Server;
  port: number;
}

function makeConfig(overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig {
  return {
    configPath: "/tmp/agent-orchestrator.yaml",
    port: 3000,
    readyThresholdMs: 300_000,
    defaults: {
      runtime: "tmux",
      agent: "claude-code",
      workspace: "worktree",
      notifiers: ["desktop"],
    },
    projects: {},
    notifiers: {},
    notificationRouting: {},
    reactions: {},
    ...overrides,
  };
}

async function listen(handler: Parameters<typeof createServer>[0]): Promise<TestServer> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo | null;
  if (!addr) {
    throw new Error("Failed to bind test server");
  }
  return { server, port: addr.port };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

const openServers: Server[] = [];

afterEach(async () => {
  while (openServers.length > 0) {
    const server = openServers.pop();
    if (!server) continue;
    await close(server);
  }
});

describe("resolveServicePorts", () => {
  it("uses stable defaults when terminal ports are not configured", () => {
    const ports = resolveServicePorts(makeConfig({ port: 3000 }));
    expect(ports).toEqual({
      dashboard: 3000,
      terminalWs: 14800,
      directTerminalWs: 14801,
    });
  });

  it("derives direct terminal port from terminalPort", () => {
    const ports = resolveServicePorts(makeConfig({ terminalPort: 16000 }));
    expect(ports.terminalWs).toBe(16000);
    expect(ports.directTerminalWs).toBe(16001);
  });

  it("derives terminal port from directTerminalPort", () => {
    const ports = resolveServicePorts(makeConfig({ directTerminalPort: 16001 }));
    expect(ports.terminalWs).toBe(16000);
    expect(ports.directTerminalWs).toBe(16001);
  });
});

describe("probeManagedServices", () => {
  it("reports all services ready when dashboard and ws health endpoints respond", async () => {
    const dashboard = await listen((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html>ok</html>");
    });
    openServers.push(dashboard.server);

    const terminal = await listen((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ instances: {} }));
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });
    openServers.push(terminal.server);

    const direct = await listen((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ active: 0, sessions: [] }));
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });
    openServers.push(direct.server);

    const probes = await probeManagedServices({
      dashboard: dashboard.port,
      terminalWs: terminal.port,
      directTerminalWs: direct.port,
    });

    expect(probes).toHaveLength(3);
    expect(probes.every((p) => p.healthy)).toBe(true);
  });

  it("flags terminal websocket outage as XDA backend down", async () => {
    const dashboard = await listen((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html>ok</html>");
    });
    openServers.push(dashboard.server);

    // Reserve an unused port to guarantee a "down" probe.
    const placeholder = await listen((_req, res) => {
      res.writeHead(200);
      res.end("placeholder");
    });
    const downPort = placeholder.port;
    await close(placeholder.server);

    const direct = await listen((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ active: 0, sessions: [] }));
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });
    openServers.push(direct.server);

    const probes = await probeManagedServices({
      dashboard: dashboard.port,
      terminalWs: downPort,
      directTerminalWs: direct.port,
    });

    const terminalProbe = probes.find((p) => p.id === "terminal-ws");
    expect(terminalProbe).toBeDefined();
    expect(terminalProbe?.healthy).toBe(false);
    expect(terminalProbe?.details).toContain("XDA websocket backend down");
  });
});
