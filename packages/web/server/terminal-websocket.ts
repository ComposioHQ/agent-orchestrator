/**
 * Terminal server that manages ttyd instances for tmux sessions.
 *
 * Runs alongside Next.js. Spawns a ttyd process per session on demand,
 * each on a unique localhost port. The dashboard stays on this server's
 * public port while authenticated HTTP and WebSocket proxying forward
 * requests to the internal ttyd instance.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { createCorrelationId } from "@composio/ao-core";
import { TerminalAuthError, verifyTerminalAccess, verifyTerminalAccessNoRateLimit } from "./terminal-auth.js";
import { findTmux } from "./tmux-utils.js";
import { createObserverContext, inferProjectId } from "./terminal-observability.js";

/** Cached full path to tmux binary */
const TMUX = findTmux();
console.log(`[Terminal] Using tmux: ${TMUX}`);

interface TtydInstance {
  sessionId: string;
  port: number;
  process: ChildProcess;
}

interface TerminalHealthMetrics {
  activeInstances: number;
  totalSpawns: number;
  totalErrors: number;
  totalReused: number;
  lastSpawnAt?: string;
  lastErrorAt?: string;
  lastErrorReason?: string;
}

interface TerminalServerError {
  code: "port_exhausted" | "terminal_start_timeout" | "terminal_unavailable";
  statusCode: number;
  message: string;
  logMessage: string;
}

const instances = new Map<string, TtydInstance>();
const metrics: TerminalHealthMetrics = {
  activeInstances: 0,
  totalSpawns: 0,
  totalErrors: 0,
  totalReused: 0,
};
const availablePorts = new Set<number>(); // Pool of recycled ports
let nextPort = 7800; // Start ttyd instances from port 7800
const MAX_PORT = 7900; // Prevent unbounded port allocation

const { config: observabilityConfig, observer } = createObserverContext("terminal-websocket");

function getTerminalProxyPath(sessionId: string): string {
  return `/terminal/${sessionId}`;
}

function extractProxySessionId(pathname: string): string | null {
  const match = pathname.match(/^\/terminal\/([a-zA-Z0-9_-]+)(?:\/.*)?$/);
  return match?.[1] ?? null;
}

function writeJsonError(
  res: ServerResponse,
  statusCode: number,
  message: string,
  retryAfterSeconds?: number,
): void {
  if (retryAfterSeconds !== undefined) {
    res.setHeader("Retry-After", String(retryAfterSeconds));
  }
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: message }));
}

function writeUpgradeError(
  socket: Duplex,
  statusCode: number,
  message: string,
  retryAfterSeconds?: number,
): void {
  const statusText =
    statusCode === 400
      ? "Bad Request"
      : statusCode === 401
        ? "Unauthorized"
        : statusCode === 403
          ? "Forbidden"
          : statusCode === 404
            ? "Not Found"
            : statusCode === 429
              ? "Too Many Requests"
              : "Service Unavailable";
  const lines = [
    `HTTP/1.1 ${statusCode} ${statusText}`,
    "Connection: close",
    "Content-Type: text/plain; charset=utf-8",
    `Content-Length: ${Buffer.byteLength(message)}`,
  ];
  if (retryAfterSeconds !== undefined) {
    lines.push(`Retry-After: ${retryAfterSeconds}`);
  }
  socket.end(`${lines.join("\r\n")}\r\n\r\n${message}`);
}

function recordWebsocketMetric(input: {
  metric: "websocket_connect" | "websocket_disconnect" | "websocket_error";
  outcome: "success" | "failure";
  sessionId?: string;
  reason?: string;
  data?: Record<string, unknown>;
}): void {
  if (!observer) {
    return;
  }

  const correlationId = createCorrelationId("ws");
  observer.recordOperation({
    metric: input.metric,
    operation: `terminal.websocket.${input.metric}`,
    outcome: input.outcome,
    correlationId,
    projectId: input.sessionId ? inferProjectId(observabilityConfig, input.sessionId) : undefined,
    sessionId: input.sessionId,
    reason: input.reason,
    data: input.data,
    level: input.outcome === "failure" ? "error" : "info",
  });
}

/**
 * Check if ttyd is ready to accept connections by making a test request.
 * Returns a promise that resolves when ttyd is ready or rejects after timeout.
 * Properly cancels pending timeouts and requests to prevent memory leaks.
 */
function waitForTtyd(port: number, sessionId: string, timeoutMs = 3000): Promise<void> {
  const startTime = Date.now();
  let timeoutId: NodeJS.Timeout | null = null;
  let pendingReq: ReturnType<typeof request> | null = null;
  let settled = false;

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      settled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (pendingReq) {
        pendingReq.destroy();
        pendingReq = null;
      }
    };

    const checkReady = () => {
      if (settled) return;

      if (Date.now() - startTime > timeoutMs) {
        cleanup();
        reject(new Error(`ttyd did not become ready within ${timeoutMs}ms`));
        return;
      }

      const req = request(
        {
          hostname: "127.0.0.1",
          port,
          path: `${getTerminalProxyPath(sessionId)}/`,
          method: "GET",
          timeout: 500,
        },
        () => {
          // Any response (even 404) means ttyd is listening
          cleanup();
          resolve();
        },
      );

      pendingReq = req;

      req.on("timeout", () => {
        if (settled) return;
        req.destroy();
        pendingReq = null;
        timeoutId = setTimeout(checkReady, 100);
      });

      req.on("error", () => {
        if (settled) return;
        pendingReq = null;
        timeoutId = setTimeout(checkReady, 100);
      });

      req.end();
    };

    checkReady();
  });
}

/**
 * Spawn or reuse a ttyd instance for a tmux session.
 *
 * @param sessionId - User-facing session ID (used for base-path and proxy URL)
 * @param tmuxSessionName - Actual tmux session name (may be hash-prefixed)
 */
function getOrSpawnTtyd(sessionId: string, tmuxSessionName: string): TtydInstance {
  const existing = instances.get(sessionId);
  if (existing) {
    metrics.totalReused += 1;
    recordWebsocketMetric({
      metric: "websocket_connect",
      outcome: "success",
      sessionId,
      data: { reused: true, port: existing.port },
    });
    return existing;
  }

  let port: number;
  if (availablePorts.size > 0) {
    port = availablePorts.values().next().value as number;
    availablePorts.delete(port);
  } else {
    if (nextPort >= MAX_PORT) {
      throw new Error(`Port exhaustion: reached maximum of ${MAX_PORT - 7800} terminal instances`);
    }
    port = nextPort++;
  }

  console.log(`[Terminal] Spawning ttyd for ${tmuxSessionName} on port ${port}`);
  metrics.totalSpawns += 1;
  metrics.lastSpawnAt = new Date().toISOString();

  const mouseProc = spawn(TMUX, ["set-option", "-t", tmuxSessionName, "mouse", "on"]);
  mouseProc.on("error", (error) => {
    console.error(`[Terminal] Failed to set mouse mode for ${tmuxSessionName}:`, error.message);
  });

  const statusProc = spawn(TMUX, ["set-option", "-t", tmuxSessionName, "status", "off"]);
  statusProc.on("error", (error) => {
    console.error(`[Terminal] Failed to hide status bar for ${tmuxSessionName}:`, error.message);
  });

  const proc = spawn(
    "ttyd",
    [
      "--writable",
      "--port",
      String(port),
      "--base-path",
      getTerminalProxyPath(sessionId),
      TMUX,
      "attach-session",
      "-t",
      tmuxSessionName,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  proc.stdout?.on("data", (data: Buffer) => {
    console.log(`[Terminal] ttyd ${sessionId}: ${data.toString().trim()}`);
  });

  proc.stderr?.on("data", (data: Buffer) => {
    console.log(`[Terminal] ttyd ${sessionId}: ${data.toString().trim()}`);
  });

  proc.once("exit", (code) => {
    console.log(`[Terminal] ttyd ${sessionId} exited with code ${code}`);
    const current = instances.get(sessionId);
    if (current?.process === proc) {
      instances.delete(sessionId);
      metrics.activeInstances = instances.size;
      if (code === 0) {
        availablePorts.add(port);
      }
    }
    recordWebsocketMetric({
      metric: "websocket_disconnect",
      outcome: code === 0 ? "success" : "failure",
      sessionId,
      reason: `ttyd_exit:${code}`,
      data: { port },
    });
  });

  proc.once("error", (error) => {
    console.error(`[Terminal] ttyd ${sessionId} error:`, error.message);
    const current = instances.get(sessionId);
    if (current?.process === proc) {
      instances.delete(sessionId);
      metrics.activeInstances = instances.size;
    }
    metrics.totalErrors += 1;
    metrics.lastErrorAt = new Date().toISOString();
    metrics.lastErrorReason = error.message;
    recordWebsocketMetric({
      metric: "websocket_error",
      outcome: "failure",
      sessionId,
      reason: error.message,
      data: { port },
    });
    try {
      proc.kill();
    } catch {
      // Ignore kill errors if process already dead
    }
  });

  const instance: TtydInstance = { sessionId, port, process: proc };
  instances.set(sessionId, instance);
  metrics.activeInstances = instances.size;
  recordWebsocketMetric({
    metric: "websocket_connect",
    outcome: "success",
    sessionId,
    data: { reused: false, port },
  });
  return instance;
}

function asTerminalAuthError(error: unknown): TerminalAuthError | undefined {
  return error instanceof TerminalAuthError ? error : undefined;
}

function classifyTerminalServerError(error: unknown): TerminalServerError {
  const logMessage = error instanceof Error ? error.message : String(error);

  if (logMessage.startsWith("Port exhaustion:")) {
    return {
      code: "port_exhausted",
      statusCode: 503,
      message: "Terminal capacity exhausted",
      logMessage,
    };
  }

  if (logMessage.includes("did not become ready within")) {
    return {
      code: "terminal_start_timeout",
      statusCode: 503,
      message: "Terminal startup timed out",
      logMessage,
    };
  }

  return {
    code: "terminal_unavailable",
    statusCode: 503,
    message: "Failed to start terminal",
    logMessage,
  };
}

function handleTerminalStartupError(
  sessionId: string,
  error: unknown,
): TerminalServerError {
  const terminalError = classifyTerminalServerError(error);
  console.error(`[Terminal] Failed to prepare terminal for ${sessionId}:`, terminalError.logMessage);
  metrics.totalErrors += 1;
  metrics.lastErrorAt = new Date().toISOString();
  metrics.lastErrorReason = terminalError.logMessage;
  recordWebsocketMetric({
    metric: "websocket_error",
    outcome: "failure",
    sessionId,
    reason: terminalError.code,
    data: { message: terminalError.logMessage },
  });
  return terminalError;
}

function proxyHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  targetPort: number,
  targetPath: string,
  sessionId: string,
): void {
  const proxyReq = request(
    {
      hostname: "127.0.0.1",
      port: targetPort,
      method: req.method,
      path: targetPath,
      headers: {
        ...req.headers,
        host: `127.0.0.1:${targetPort}`,
      },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );

  proxyReq.on("error", (error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Terminal] HTTP proxy failed for ${sessionId}:`, message);
    writeJsonError(res, 502, "Terminal proxy failed");
  });

  req.pipe(proxyReq);
}

function proxyUpgradeRequest(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  targetPort: number,
  sessionId: string,
): void {
  const proxyReq = request({
    hostname: "127.0.0.1",
    port: targetPort,
    method: req.method,
    path: req.url ?? "/",
    headers: {
      ...req.headers,
      host: `127.0.0.1:${targetPort}`,
    },
  });

  proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
    const statusLine = `HTTP/1.1 ${proxyRes.statusCode ?? 101} ${proxyRes.statusMessage ?? "Switching Protocols"}`;
    const headerLines = Object.entries(proxyRes.headers).flatMap(([name, value]) => {
      if (value === undefined) return [];
      return Array.isArray(value)
        ? value.map((item) => `${name}: ${item}`)
        : [`${name}: ${value}`];
    });

    socket.write(`${statusLine}\r\n${headerLines.join("\r\n")}\r\n\r\n`);
    if (proxyHead.length > 0) {
      socket.write(proxyHead);
    }
    if (head.length > 0) {
      proxySocket.write(head);
    }
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
  });

  proxyReq.on("response", (proxyRes) => {
    proxyRes.resume();
    writeUpgradeError(socket, proxyRes.statusCode ?? 502, "Terminal upgrade rejected");
  });

  proxyReq.on("error", (error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Terminal] WebSocket proxy failed for ${sessionId}:`, message);
    writeUpgradeError(socket, 502, "Terminal proxy failed");
  });

  proxyReq.end();
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname === "/terminal") {
    const sessionId = url.searchParams.get("session");
    if (!sessionId) {
      writeJsonError(res, 400, "Missing session parameter");
      recordWebsocketMetric({
        metric: "websocket_error",
        outcome: "failure",
        reason: "missing_session_parameter",
      });
      return;
    }

    try {
      verifyTerminalAccess({
        sessionId,
        headers: req.headers,
        remoteAddress: req.socket.remoteAddress,
      });
      const host = req.headers.host ?? "localhost";
      const forwardedProto = req.headers["x-forwarded-proto"];
      const protocol =
        typeof forwardedProto === "string" && forwardedProto.length > 0
          ? forwardedProto
          : "http";

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          url: `${protocol}://${host}${getTerminalProxyPath(sessionId)}/`,
          sessionId,
        }),
      );
    } catch (error) {
      const authError = asTerminalAuthError(error);
      if (authError) {
        recordWebsocketMetric({
          metric: "websocket_error",
          outcome: "failure",
          sessionId,
          reason: authError.code,
        });
        writeJsonError(
          res,
          authError.statusCode,
          authError.message,
          authError.retryAfterSeconds,
        );
      } else {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[Terminal] Auth verifier failed for ${sessionId}:`, message);
        recordWebsocketMetric({
          metric: "websocket_error",
          outcome: "failure",
          sessionId,
          reason: "auth_verifier_unavailable",
          data: { message },
        });
        writeJsonError(res, 503, "Terminal authorization unavailable");
      }
    }
    return;
  }

  const sessionId = extractProxySessionId(url.pathname);
  if (sessionId) {
    try {
      const authorized = verifyTerminalAccessNoRateLimit({
        sessionId,
        headers: req.headers,
        remoteAddress: req.socket.remoteAddress,
      });
      try {
        const instance = getOrSpawnTtyd(authorized.sessionId, authorized.tmuxSessionName);
        await waitForTtyd(instance.port, authorized.sessionId);
        proxyHttpRequest(req, res, instance.port, `${url.pathname}${url.search}`, sessionId);
      } catch (error) {
        const terminalError = handleTerminalStartupError(sessionId, error);
        writeJsonError(res, terminalError.statusCode, terminalError.message);
      }
    } catch (error) {
      const authError = asTerminalAuthError(error);
      if (authError) {
        recordWebsocketMetric({
          metric: "websocket_error",
          outcome: "failure",
          sessionId,
          reason: authError.code,
        });
        writeJsonError(res, authError.statusCode, authError.message, authError.retryAfterSeconds);
      } else {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[Terminal] Auth verifier failed for ${sessionId}:`, message);
        recordWebsocketMetric({
          metric: "websocket_error",
          outcome: "failure",
          sessionId,
          reason: "auth_verifier_unavailable",
          data: { message },
        });
        writeJsonError(res, 503, "Terminal authorization unavailable");
      }
    }
    return;
  }

  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        instances: Object.fromEntries(
          [...instances.entries()].map(([id, inst]) => [id, { port: inst.port }]),
        ),
        metrics,
      }),
    );
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const sessionId = extractProxySessionId(url.pathname);

  if (!sessionId) {
    writeUpgradeError(socket, 404, "Not found");
    return;
  }

  void (async () => {
    try {
      const authorized = verifyTerminalAccess({
        sessionId,
        headers: req.headers,
        remoteAddress: req.socket.remoteAddress,
      });
      try {
        const instance = getOrSpawnTtyd(authorized.sessionId, authorized.tmuxSessionName);
        await waitForTtyd(instance.port, authorized.sessionId);
        proxyUpgradeRequest(req, socket, head, instance.port, sessionId);
      } catch (error) {
        const terminalError = handleTerminalStartupError(sessionId, error);
        writeUpgradeError(socket, terminalError.statusCode, terminalError.message);
      }
    } catch (error) {
      const authError = asTerminalAuthError(error);
      if (authError) {
        recordWebsocketMetric({
          metric: "websocket_error",
          outcome: "failure",
          sessionId,
          reason: authError.code,
        });
        writeUpgradeError(socket, authError.statusCode, authError.message, authError.retryAfterSeconds);
      } else {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[Terminal] Auth verifier failed for ${sessionId}:`, message);
        recordWebsocketMetric({
          metric: "websocket_error",
          outcome: "failure",
          sessionId,
          reason: "auth_verifier_unavailable",
          data: { message },
        });
        writeUpgradeError(socket, 503, "Terminal authorization unavailable");
      }
    }
  })();
});

const PORT = parseInt(process.env.TERMINAL_PORT ?? "14800", 10);

server.listen(PORT, () => {
  console.log(`[Terminal] Server listening on port ${PORT}`);
});

function shutdown(signal: string) {
  console.log(`[Terminal] Received ${signal}, shutting down...`);
  for (const [, instance] of instances) {
    instance.process.kill();
  }
  server.close(() => {
    console.log("[Terminal] Server closed");
    process.exit(0);
  });
  const forceExitTimer = setTimeout(() => {
    console.error("[Terminal] Forced shutdown after timeout");
    process.exit(1);
  }, 5000);
  forceExitTimer.unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
