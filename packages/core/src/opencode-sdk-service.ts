import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createOpencodeClient } from "@opencode-ai/sdk";

export interface OpenCodeServerRef {
  url: string;
  hostname: string;
  port: number;
  pid: number;
  workspacePath: string;
}

export interface OpenCodeSessionRef {
  sessionId: string;
  title?: string;
}

const DEFAULT_SERVER_HOSTNAME = "127.0.0.1";
const DEFAULT_SERVER_TIMEOUT_MS = 20_000;

type OpenCodeStatus = "working" | "idle" | "waiting_input" | "exited" | "unknown";

function parseModel(model: string | undefined): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined;
  const idx = model.indexOf("/");
  if (idx <= 0 || idx >= model.length - 1) return undefined;
  return {
    providerID: model.slice(0, idx),
    modelID: model.slice(idx + 1),
  };
}

async function getFreePort(hostname: string): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, hostname, () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close();
        reject(new Error("Failed to allocate OpenCode port"));
        return;
      }
      const port = addr.port;
      srv.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: string | undefined;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/global/health`);
      if (response.ok) {
        const body = (await response.json()) as { healthy?: boolean };
        if (body.healthy === true) {
          return;
        }
      }
      lastError = `health status ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`OpenCode server health check timed out at ${url}: ${lastError ?? "unknown"}`);
}

export async function ensureOpenCodeServer(params: {
  workspacePath: string;
  hostname?: string;
  port?: number;
  timeoutMs?: number;
}): Promise<OpenCodeServerRef> {
  const hostname = params.hostname ?? DEFAULT_SERVER_HOSTNAME;
  const port = params.port ?? (await getFreePort(hostname));
  const timeoutMs = params.timeoutMs ?? DEFAULT_SERVER_TIMEOUT_MS;
  const url = `http://${hostname}:${port}`;

  const child = spawn("opencode", ["serve", "--hostname", hostname, "--port", String(port)], {
    cwd: params.workspacePath,
    detached: true,
    stdio: "ignore",
  });

  if (!child.pid) {
    throw new Error("Failed to start OpenCode server process");
  }

  child.unref();
  await waitForHealth(url, timeoutMs);

  return {
    url,
    hostname,
    port,
    pid: child.pid,
    workspacePath: params.workspacePath,
  };
}

export function getOpenCodeClient(baseUrl: string) {
  return createOpencodeClient({
    baseUrl,
    throwOnError: true,
  });
}

export async function createOpenCodeSession(params: {
  baseUrl: string;
  title: string;
}): Promise<OpenCodeSessionRef> {
  const client = getOpenCodeClient(params.baseUrl);
  const response = await client.session.create({
    body: { title: params.title },
  });

  const data = response.data as { id?: string; title?: string } | undefined;
  if (!data?.id) {
    throw new Error("OpenCode session.create returned no session id");
  }

  return {
    sessionId: data.id,
    title: data.title,
  };
}

export async function promptOpenCodeSession(params: {
  baseUrl: string;
  sessionId: string;
  text: string;
  model?: string;
}): Promise<void> {
  const client = getOpenCodeClient(params.baseUrl);
  const model = parseModel(params.model);

  await client.session.prompt({
    path: { id: params.sessionId },
    body: {
      ...(model ? { model } : {}),
      parts: [{ type: "text", text: params.text }],
    },
  });
}

export async function getOpenCodeSessionStatus(params: {
  baseUrl: string;
  sessionId: string;
}): Promise<OpenCodeStatus> {
  const client = getOpenCodeClient(params.baseUrl);
  const response = await client.session.status();
  const statusMap = response.data as Record<string, string> | undefined;
  const value = statusMap?.[params.sessionId];

  switch (value) {
    case "working":
      return "working";
    case "idle":
      return "idle";
    case "waiting_input":
      return "waiting_input";
    case "exited":
      return "exited";
    default:
      return "unknown";
  }
}

export async function getOpenCodeSessionInfo(params: {
  baseUrl: string;
  sessionId: string;
}): Promise<{ summary: string | null; costUsd?: number; inputTokens?: number; outputTokens?: number }> {
  const client = getOpenCodeClient(params.baseUrl);
  const session = await client.session.get({ path: { id: params.sessionId } });
  const sessionData = session.data as { title?: string } | undefined;

  return {
    summary: sessionData?.title ?? null,
  };
}

export async function abortOpenCodeSession(params: {
  baseUrl: string;
  sessionId: string;
}): Promise<void> {
  const client = getOpenCodeClient(params.baseUrl);
  await client.session.abort({ path: { id: params.sessionId } });
}

export async function deleteOpenCodeSession(params: {
  baseUrl: string;
  sessionId: string;
}): Promise<void> {
  const client = getOpenCodeClient(params.baseUrl);
  await client.session.delete({ path: { id: params.sessionId } });
}

export async function stopOpenCodeServer(serverPid: number): Promise<void> {
  if (!Number.isFinite(serverPid) || serverPid <= 0) return;

  try {
    process.kill(serverPid, "SIGTERM");
  } catch {
    return;
  }

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(serverPid, 0);
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch {
      return;
    }
  }

  try {
    process.kill(serverPid, "SIGKILL");
  } catch {
    // best effort
  }
}
