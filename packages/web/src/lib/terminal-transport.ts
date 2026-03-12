import { spawn, type ChildProcess } from "node:child_process";
import { request } from "node:http";
import { resolve } from "node:path";
import type {
  TerminalTransportHealth,
  TerminalTransportServiceHealth,
  TerminalTransportServiceKey,
  TerminalTransportServiceStatus,
} from "@/lib/types";

const HEALTH_CHECK_TIMEOUT_MS = 1_000;
const SERVICE_START_TIMEOUT_MS = 8_000;
const HEALTH_CHECK_INTERVAL_MS = 250;
const MAX_RESTART_DELAY_MS = 5_000;
const MIN_RESTART_DELAY_MS = 500;
const RESTART_BACKOFF_FACTOR = 2;

export interface TerminalTransportServiceDefinition {
  key: TerminalTransportServiceKey;
  label: string;
  port: number;
  healthPath: string;
  launch: () => {
    command: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
  };
}

interface TerminalTransportServiceState {
  child: ChildProcess | null;
  status: TerminalTransportServiceStatus;
  restartCount: number;
  lastCheckedAt: string;
  lastHealthyAt: string | null;
  lastStartedAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  supervisorOwned: boolean;
  restartDelayMs: number;
  restartTimer: ReturnType<typeof setTimeout> | null;
  ensurePromise: Promise<void> | null;
}

interface TerminalTransportSupervisorState {
  initialized: boolean;
  services: Record<TerminalTransportServiceKey, TerminalTransportServiceState>;
  definitions: Record<TerminalTransportServiceKey, TerminalTransportServiceDefinition>;
  shutdownInstalled: boolean;
}

function getTsxCommand(cwd: string): string {
  const binName = process.platform === "win32" ? "tsx.cmd" : "tsx";
  return resolve(cwd, "node_modules", ".bin", binName);
}

const globalForTerminalTransport = globalThis as typeof globalThis & {
  _aoTerminalTransportSupervisor?: TerminalTransportSupervisorState;
};

function nowIso(): string {
  return new Date().toISOString();
}

function buildDefaultDefinitions(): Record<
  TerminalTransportServiceKey,
  TerminalTransportServiceDefinition
> {
  const cwd = process.cwd();
  const webServerDir = resolve(cwd, "server");
  const terminalPort = Number.parseInt(process.env["TERMINAL_PORT"] ?? "14800", 10);
  const directTerminalPort = Number.parseInt(process.env["DIRECT_TERMINAL_PORT"] ?? "14801", 10);

  return {
    terminalWebsocket: {
      key: "terminalWebsocket",
      label: "terminal websocket",
      port: terminalPort,
      healthPath: "/health",
      launch: () => ({
        command: getTsxCommand(cwd),
        args: [resolve(webServerDir, "terminal-websocket.ts")],
        cwd,
        env: { ...process.env, TERMINAL_PORT: String(terminalPort) },
      }),
    },
    directTerminalWebsocket: {
      key: "directTerminalWebsocket",
      label: "direct terminal websocket",
      port: directTerminalPort,
      healthPath: "/health",
      launch: () => ({
        command: getTsxCommand(cwd),
        args: [resolve(webServerDir, "direct-terminal-ws.ts")],
        cwd,
        env: { ...process.env, DIRECT_TERMINAL_PORT: String(directTerminalPort) },
      }),
    },
  };
}

function createServiceState(): TerminalTransportServiceState {
  return {
    child: null,
    status: "degraded",
    restartCount: 0,
    lastCheckedAt: nowIso(),
    lastHealthyAt: null,
    lastStartedAt: null,
    lastErrorAt: null,
    lastError: null,
    supervisorOwned: false,
    restartDelayMs: MIN_RESTART_DELAY_MS,
    restartTimer: null,
    ensurePromise: null,
  };
}

function getSupervisorState(): TerminalTransportSupervisorState {
  if (!globalForTerminalTransport._aoTerminalTransportSupervisor) {
    globalForTerminalTransport._aoTerminalTransportSupervisor = {
      initialized: false,
      definitions: buildDefaultDefinitions(),
      services: {
        terminalWebsocket: createServiceState(),
        directTerminalWebsocket: createServiceState(),
      },
      shutdownInstalled: false,
    };
  }

  const state = globalForTerminalTransport._aoTerminalTransportSupervisor;
  if (!state.shutdownInstalled) {
    const shutdown = () => {
      for (const key of Object.keys(state.services) as TerminalTransportServiceKey[]) {
        const service = state.services[key];
        if (service.restartTimer) {
          clearTimeout(service.restartTimer);
          service.restartTimer = null;
        }
        if (service.child && service.child.exitCode === null) {
          service.child.kill("SIGTERM");
        }
      }
    };
    process.once("exit", shutdown);
    state.shutdownInstalled = true;
  }
  return state;
}

function probeService(
  definition: TerminalTransportServiceDefinition,
): Promise<{ healthy: boolean; error?: string }> {
  return new Promise((resolve) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: definition.port,
        path: definition.healthPath,
        method: "GET",
        timeout: HEALTH_CHECK_TIMEOUT_MS,
      },
      (res) => {
        const statusCode = res.statusCode ?? 0;
        res.resume();
        resolve({
          healthy: statusCode >= 200 && statusCode < 300,
          error: statusCode >= 200 && statusCode < 300 ? undefined : `HTTP ${statusCode}`,
        });
      },
    );

    req.on("timeout", () => {
      req.destroy(new Error("Health check timed out"));
    });
    req.on("error", (error) => {
      resolve({ healthy: false, error: error.message });
    });
    req.end();
  });
}

async function waitForHealthy(definition: TerminalTransportServiceDefinition): Promise<void> {
  const deadline = Date.now() + SERVICE_START_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const probe = await probeService(definition);
    if (probe.healthy) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_CHECK_INTERVAL_MS));
  }

  throw new Error(`${definition.label} did not become healthy on port ${definition.port}`);
}

function scheduleRestart(definition: TerminalTransportServiceDefinition): void {
  const supervisor = getSupervisorState();
  const service = supervisor.services[definition.key];
  if (service.restartTimer) {
    return;
  }

  service.status = "restarting";
  service.restartTimer = setTimeout(() => {
    service.restartTimer = null;
    void ensureServiceHealthy(definition.key, true);
  }, service.restartDelayMs);
  service.restartDelayMs = Math.min(
    MAX_RESTART_DELAY_MS,
    service.restartDelayMs * RESTART_BACKOFF_FACTOR,
  );
}

async function startService(definition: TerminalTransportServiceDefinition): Promise<void> {
  const supervisor = getSupervisorState();
  const service = supervisor.services[definition.key];
  const launch = definition.launch();
  let startupSettled = false;
  let rejectStartup: ((error: Error) => void) | null = null;
  const startupFailure = new Promise<never>((_, reject) => {
    rejectStartup = reject;
  });

  service.status = service.restartCount > 0 ? "restarting" : "starting";
  service.lastStartedAt = nowIso();

  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: launch.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  service.child = child;
  service.supervisorOwned = true;

  child.stdout?.on("data", () => {});
  child.stderr?.on("data", (data: Buffer) => {
    service.lastErrorAt = nowIso();
    service.lastError = data.toString().trim() || service.lastError;
  });

  child.once("error", (error) => {
    service.lastErrorAt = nowIso();
    service.lastError = error.message;
    service.status = "degraded";
    if (!startupSettled) {
      startupSettled = true;
      rejectStartup?.(error);
    }
    scheduleRestart(definition);
  });

  child.once("exit", (code, signal) => {
    if (service.child === child) {
      service.child = null;
    }
    service.lastErrorAt = nowIso();
    service.lastError = `Process exited (${signal ?? code ?? "unknown"})`;
    service.status = "degraded";
    if (!startupSettled) {
      startupSettled = true;
      rejectStartup?.(new Error(service.lastError));
    }
    scheduleRestart(definition);
  });

  await Promise.race([waitForHealthy(definition), startupFailure]);
  startupSettled = true;
  service.status = "healthy";
  service.lastHealthyAt = nowIso();
  service.lastError = null;
  service.lastErrorAt = null;
  service.restartDelayMs = MIN_RESTART_DELAY_MS;
}

async function ensureServiceHealthy(
  key: TerminalTransportServiceKey,
  heal: boolean,
): Promise<void> {
  const supervisor = getSupervisorState();
  const definition = supervisor.definitions[key];
  const service = supervisor.services[key];

  service.lastCheckedAt = nowIso();
  const probe = await probeService(definition);
  if (probe.healthy) {
    service.status = "healthy";
    service.lastHealthyAt = service.lastCheckedAt;
    service.lastError = null;
    service.lastErrorAt = null;
    return;
  }

  service.status =
    heal && service.child && service.status !== "healthy" ? service.status : "degraded";
  service.lastError = probe.error ?? `${definition.label} unavailable`;
  service.lastErrorAt = service.lastCheckedAt;

  if (!heal) {
    return;
  }

  if (!service.ensurePromise) {
    service.ensurePromise = (async () => {
      const isRestart = service.lastStartedAt !== null;
      if (service.child && service.child.exitCode === null) {
        try {
          service.child.kill("SIGTERM");
        } catch (error) {
          service.lastErrorAt = nowIso();
          service.lastError = error instanceof Error ? error.message : String(error);
        }
      }

      if (isRestart) {
        service.restartCount += 1;
      }
      await startService(definition);
    })().finally(() => {
      service.ensurePromise = null;
    });
  }

  await service.ensurePromise;
}

function buildHealthSnapshot(): TerminalTransportHealth {
  const supervisor = getSupervisorState();
  const checkedAt = nowIso();
  const services = Object.fromEntries(
    (Object.keys(supervisor.services) as TerminalTransportServiceKey[]).map((key) => {
      const definition = supervisor.definitions[key];
      const service = supervisor.services[key];
      const healthy = service.status === "healthy";
      const message = healthy
        ? `${definition.label} healthy`
        : service.status === "restarting"
          ? `${definition.label} restarting on port ${definition.port}`
          : service.status === "starting"
            ? `${definition.label} starting on port ${definition.port}`
            : (service.lastError ?? `${definition.label} unavailable on port ${definition.port}`);
      return [
        key,
        {
          key,
          label: definition.label,
          port: definition.port,
          healthPath: definition.healthPath,
          status: service.status,
          healthy,
          message,
          pid: service.child?.pid ?? null,
          restartCount: service.restartCount,
          lastCheckedAt: checkedAt,
          lastHealthyAt: service.lastHealthyAt,
          lastStartedAt: service.lastStartedAt,
          lastErrorAt: service.lastErrorAt,
          lastError: service.lastError,
          supervisorOwned: service.supervisorOwned,
        } satisfies TerminalTransportServiceHealth,
      ];
    }),
  ) as Record<TerminalTransportServiceKey, TerminalTransportServiceHealth>;

  const degradedServices = Object.values(services).filter((service) => !service.healthy);

  return {
    status: degradedServices.length === 0 ? "healthy" : "degraded",
    degraded: degradedServices.length > 0,
    message:
      degradedServices.length === 0
        ? "Terminal websocket services healthy"
        : `Terminal transport degraded: ${degradedServices.map((service) => service.label).join(", ")}`,
    checkedAt,
    services,
  };
}

export async function getTerminalTransportHealth(
  options: { heal?: boolean } = {},
): Promise<TerminalTransportHealth> {
  const heal = options.heal ?? true;
  const supervisor = getSupervisorState();

  if (!supervisor.initialized) {
    supervisor.initialized = true;
  }

  await Promise.all(
    (Object.keys(supervisor.definitions) as TerminalTransportServiceKey[]).map((key) =>
      ensureServiceHealthy(key, heal).catch((error) => {
        const service = supervisor.services[key];
        service.status = service.child ? service.status : "degraded";
        service.lastErrorAt = nowIso();
        service.lastError = error instanceof Error ? error.message : String(error);
      }),
    ),
  );

  return buildHealthSnapshot();
}

export function configureTerminalTransportForTests(input: {
  definitions: Record<TerminalTransportServiceKey, TerminalTransportServiceDefinition>;
}): void {
  const supervisor = getSupervisorState();
  supervisor.definitions = input.definitions;
  supervisor.initialized = false;
  for (const key of Object.keys(supervisor.services) as TerminalTransportServiceKey[]) {
    const service = supervisor.services[key];
    if (service.restartTimer) {
      clearTimeout(service.restartTimer);
      service.restartTimer = null;
    }
    if (service.child && service.child.exitCode === null) {
      service.child.kill("SIGTERM");
    }
    supervisor.services[key] = createServiceState();
  }
}

export function resetTerminalTransportForTests(): void {
  configureTerminalTransportForTests({ definitions: buildDefaultDefinitions() });
}
