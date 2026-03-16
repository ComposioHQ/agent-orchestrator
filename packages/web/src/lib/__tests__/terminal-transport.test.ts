import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  configureTerminalTransportForTests,
  getTerminalTransportHealth,
  resetTerminalTransportForTests,
  type TerminalTransportServiceDefinition,
} from "@/lib/terminal-transport";

function createServiceScript(dir: string): string {
  const scriptPath = join(dir, "test-health-service.js");
  writeFileSync(
    scriptPath,
    [
      'const http = require("http");',
      "const port = Number(process.env.TEST_SERVICE_PORT);",
      'const healthPath = process.env.TEST_HEALTH_PATH || "/health";',
      "const server = http.createServer((req, res) => {",
      "  if (req.url === healthPath) {",
      '    res.writeHead(200, { "Content-Type": "application/json" });',
      "    res.end(JSON.stringify({ ok: true, pid: process.pid }));",
      "    return;",
      "  }",
      "  res.writeHead(404);",
      '  res.end("not found");',
      "});",
      'server.listen(port, "127.0.0.1");',
      'process.on("SIGTERM", () => {',
      "  server.close(() => process.exit(0));",
      "});",
    ].join("\n"),
    "utf-8",
  );
  return scriptPath;
}

function createDelayedServiceScript(dir: string, delayMs: number): string {
  const scriptPath = join(dir, "test-delayed-health-service.js");
  writeFileSync(
    scriptPath,
    [
      'const http = require("http");',
      "const port = Number(process.env.TEST_SERVICE_PORT);",
      'const healthPath = process.env.TEST_HEALTH_PATH || "/health";',
      `const delayMs = ${delayMs};`,
      "const server = http.createServer((req, res) => {",
      "  if (req.url === healthPath) {",
      '    res.writeHead(200, { "Content-Type": "application/json" });',
      "    res.end(JSON.stringify({ ok: true, pid: process.pid }));",
      "    return;",
      "  }",
      "  res.writeHead(404);",
      '  res.end("not found");',
      "});",
      'setTimeout(() => server.listen(port, "127.0.0.1"), delayMs);',
      'process.on("SIGTERM", () => {',
      "  server.close(() => process.exit(0));",
      "});",
    ].join("\n"),
    "utf-8",
  );
  return scriptPath;
}

function makeDefinition(
  key: TerminalTransportServiceDefinition["key"],
  label: string,
  port: number,
  scriptPath: string,
): TerminalTransportServiceDefinition {
  return {
    key,
    label,
    port,
    healthPath: "/health",
    launch: () => ({
      command: process.execPath,
      args: [scriptPath],
      cwd: dir,
      env: {
        ...process.env,
        TEST_SERVICE_PORT: String(port),
        TEST_HEALTH_PATH: "/health",
      },
    }),
  };
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Timed out waiting for condition");
}

let dir = "";
let conflictingServer: Server | null = null;

afterEach(async () => {
  resetTerminalTransportForTests();
  await new Promise<void>((resolve) => {
    if (!conflictingServer) {
      resolve();
      return;
    }
    conflictingServer.close(() => {
      conflictingServer = null;
      resolve();
    });
  });
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = "";
  }
});

describe("terminal transport supervisor", () => {
  it("restarts a websocket service after it exits", async () => {
    dir = mkdtempSync(join(tmpdir(), "ao-terminal-transport-"));
    const scriptPath = createServiceScript(dir);
    const terminalPort = 18980;
    const directPort = 18981;

    configureTerminalTransportForTests({
      definitions: {
        terminalWebsocket: makeDefinition(
          "terminalWebsocket",
          "terminal websocket",
          terminalPort,
          scriptPath,
        ),
        directTerminalWebsocket: makeDefinition(
          "directTerminalWebsocket",
          "direct terminal websocket",
          directPort,
          scriptPath,
        ),
      },
    });

    const initial = await getTerminalTransportHealth();
    expect(initial.degraded).toBe(false);
    const originalPid = initial.services.directTerminalWebsocket.pid;
    expect(originalPid).toBeTruthy();

    process.kill(originalPid!, "SIGTERM");

    await waitFor(async () => {
      const health = await getTerminalTransportHealth();
      return (
        health.services.directTerminalWebsocket.healthy &&
        health.services.directTerminalWebsocket.restartCount >= 1 &&
        health.services.directTerminalWebsocket.pid !== originalPid
      );
    });
  });

  it("reports degraded health when the direct websocket port is already occupied", async () => {
    dir = mkdtempSync(join(tmpdir(), "ao-terminal-transport-fail-"));
    const scriptPath = createServiceScript(dir);
    conflictingServer = createServer((_req, res) => {
      res.writeHead(404);
      res.end("busy");
    });
    await new Promise<void>((resolve) => conflictingServer!.listen(18983, "127.0.0.1", resolve));

    configureTerminalTransportForTests({
      definitions: {
        terminalWebsocket: makeDefinition(
          "terminalWebsocket",
          "terminal websocket",
          18982,
          scriptPath,
        ),
        directTerminalWebsocket: {
          key: "directTerminalWebsocket",
          label: "direct terminal websocket",
          port: 18983,
          healthPath: "/health",
          launch: () =>
            makeDefinition(
              "directTerminalWebsocket",
              "direct terminal websocket",
              18983,
              scriptPath,
            ).launch(),
        },
      },
    });

    const health = await getTerminalTransportHealth();
    expect(health.degraded).toBe(true);
    expect(health.services.directTerminalWebsocket.healthy).toBe(false);
    expect(health.message).toContain("direct terminal websocket");
  });

  it("preserves transitional service status during passive health probes", async () => {
    dir = mkdtempSync(join(tmpdir(), "ao-terminal-transport-delayed-"));
    const scriptPath = createServiceScript(dir);
    const delayedScriptPath = createDelayedServiceScript(dir, 1_500);

    configureTerminalTransportForTests({
      definitions: {
        terminalWebsocket: makeDefinition(
          "terminalWebsocket",
          "terminal websocket",
          18984,
          scriptPath,
        ),
        directTerminalWebsocket: makeDefinition(
          "directTerminalWebsocket",
          "direct terminal websocket",
          18985,
          delayedScriptPath,
        ),
      },
    });

    const healingPromise = getTerminalTransportHealth({ heal: true });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const passiveSnapshot = await getTerminalTransportHealth({ heal: false });
    expect(passiveSnapshot.services.directTerminalWebsocket.status).toBe("starting");

    const recovered = await healingPromise;
    expect(recovered.services.directTerminalWebsocket.healthy).toBe(true);
  });
});
