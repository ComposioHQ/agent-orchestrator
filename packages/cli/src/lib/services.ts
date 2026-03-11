import { spawn, type ChildProcess } from "node:child_process";
import { request } from "node:http";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { generateConfigHash, type OrchestratorConfig } from "@composio/ao-core";
import { exec, execSilent } from "./shell.js";
import { findWebDir, isPortAvailable } from "./web-dir.js";

export type ServicesManager = "systemd" | "supervisor";
export type ManagerPreference = ServicesManager | "auto";

export type ManagedServiceId = "dashboard" | "terminal-ws" | "direct-terminal-ws";

export interface ServicePorts {
  dashboard: number;
  terminalWs: number;
  directTerminalWs: number;
}

export interface ManagedServiceHealth {
  id: ManagedServiceId;
  port: number;
  listening: boolean;
  healthy: boolean;
  httpStatus: number | null;
  details: string;
}

export interface ManagedServicesStatus {
  manager: ServicesManager;
  managerRunning: boolean;
  managerDetail: string;
  processStates: Record<ManagedServiceId, string>;
  services: ManagedServiceHealth[];
  allReady: boolean;
}

export interface StartManagedServicesResult {
  manager: ServicesManager;
  started: boolean;
  ready: boolean;
  status: ManagedServicesStatus;
}

const DEFAULT_DASHBOARD_PORT = 3000;
const DEFAULT_TERMINAL_PORT = 14800;
const DEFAULT_DIRECT_TERMINAL_PORT = 14801;
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;

const SERVICE_IDS: ManagedServiceId[] = ["dashboard", "terminal-ws", "direct-terminal-ws"];

interface ServiceContext {
  config: OrchestratorConfig;
  hash: string;
  webDir: string;
  ports: ServicePorts;
}

interface SystemdUnits {
  dashboard: string;
  terminalWs: string;
  directTerminalWs: string;
}

interface SupervisorStatus {
  running: boolean;
  pid: number | null;
  pidFile: string;
  logFile: string;
}

interface StartOptions {
  manager?: ManagerPreference;
  waitTimeoutMs?: number;
}

interface InstallOptions {
  manager?: ManagerPreference;
  enable?: boolean;
}

interface StopOptions {
  manager?: ManagerPreference;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "EPERM"
    ) {
      return true;
    }
    return false;
  }
}

function readPid(pidFile: string): number | null {
  if (!existsSync(pidFile)) return null;
  try {
    const raw = readFileSync(pidFile, "utf-8").trim();
    const pid = parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function clearPidFile(pidFile: string, expectedPid?: number): void {
  if (!existsSync(pidFile)) return;

  if (expectedPid !== undefined) {
    const pid = readPid(pidFile);
    if (pid !== null && pid !== expectedPid) {
      return;
    }
  }

  try {
    unlinkSync(pidFile);
  } catch {
    // Best-effort cleanup
  }
}

function getSupervisorStateDir(configPath: string): string {
  return join(homedir(), ".agent-orchestrator", "services", generateConfigHash(configPath));
}

function getSupervisorPidFile(configPath: string): string {
  return join(getSupervisorStateDir(configPath), "supervisor.pid");
}

function getSupervisorLogFile(configPath: string): string {
  return join(getSupervisorStateDir(configPath), "supervisor.log");
}

function getSupervisorStatus(configPath: string): SupervisorStatus {
  const pidFile = getSupervisorPidFile(configPath);
  const logFile = getSupervisorLogFile(configPath);
  const pid = readPid(pidFile);

  if (pid !== null && isProcessRunning(pid)) {
    return { running: true, pid, pidFile, logFile };
  }

  if (pid !== null) {
    clearPidFile(pidFile, pid);
  }

  return { running: false, pid: null, pidFile, logFile };
}

export function resolveServicePorts(config: OrchestratorConfig): ServicePorts {
  const dashboard = config.port ?? DEFAULT_DASHBOARD_PORT;
  const terminal = config.terminalPort;
  const direct = config.directTerminalPort;

  if (terminal !== undefined && direct !== undefined) {
    return { dashboard, terminalWs: terminal, directTerminalWs: direct };
  }

  if (terminal !== undefined) {
    return { dashboard, terminalWs: terminal, directTerminalWs: terminal + 1 };
  }

  if (direct !== undefined) {
    return { dashboard, terminalWs: direct - 1, directTerminalWs: direct };
  }

  return {
    dashboard,
    terminalWs: DEFAULT_TERMINAL_PORT,
    directTerminalWs: DEFAULT_DIRECT_TERMINAL_PORT,
  };
}

async function getServiceContext(config: OrchestratorConfig): Promise<ServiceContext> {
  const webDir = findWebDir();
  return {
    config,
    hash: generateConfigHash(config.configPath),
    webDir,
    ports: resolveServicePorts(config),
  };
}

function getSystemdUnits(hash: string): SystemdUnits {
  const prefix = `ao-${hash}`;
  return {
    dashboard: `${prefix}-dashboard.service`,
    terminalWs: `${prefix}-terminal-ws.service`,
    directTerminalWs: `${prefix}-direct-terminal-ws.service`,
  };
}

function escapeSystemdEnvValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function systemdEnvLine(key: string, value: string): string {
  return `Environment="${key}=${escapeSystemdEnvValue(value)}"`;
}

function buildSystemdUnitContent(
  id: ManagedServiceId,
  context: ServiceContext,
  command: string,
): string {
  const { ports, webDir, config } = context;
  const serviceName =
    id === "dashboard"
      ? "AO Dashboard"
      : id === "terminal-ws"
        ? "AO Terminal WebSocket"
        : "AO Direct Terminal WebSocket";

  const env: Array<[string, string]> = [
    ["AO_CONFIG_PATH", config.configPath],
    ["PORT", String(ports.dashboard)],
    ["TERMINAL_PORT", String(ports.terminalWs)],
    ["DIRECT_TERMINAL_PORT", String(ports.directTerminalWs)],
    ["NEXT_PUBLIC_TERMINAL_PORT", String(ports.terminalWs)],
    ["NEXT_PUBLIC_DIRECT_TERMINAL_PORT", String(ports.directTerminalWs)],
  ];

  return [
    "[Unit]",
    `Description=${serviceName}`,
    "After=network.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${webDir}`,
    ...env.map(([k, v]) => systemdEnvLine(k, v)),
    `ExecStart=/usr/bin/env npm run ${command}`,
    "Restart=always",
    "RestartSec=2",
    "KillMode=control-group",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

async function writeSystemdUnits(
  context: ServiceContext,
  opts?: { enable?: boolean },
): Promise<{ units: SystemdUnits; unitDir: string }> {
  const unitDir = join(homedir(), ".config", "systemd", "user");
  mkdirSync(unitDir, { recursive: true });

  const units = getSystemdUnits(context.hash);
  const files: Array<[string, string]> = [
    [
      units.dashboard,
      buildSystemdUnitContent("dashboard", context, "start:dashboard"),
    ],
    [
      units.terminalWs,
      buildSystemdUnitContent("terminal-ws", context, "start:terminal"),
    ],
    [
      units.directTerminalWs,
      buildSystemdUnitContent("direct-terminal-ws", context, "start:direct-terminal"),
    ],
  ];

  for (const [filename, content] of files) {
    const fullPath = join(unitDir, filename);
    if (existsSync(fullPath)) {
      const current = readFileSync(fullPath, "utf-8");
      if (current === content) continue;
    }
    writeFileSync(fullPath, content, "utf-8");
  }

  await exec("systemctl", ["--user", "daemon-reload"]);

  if (opts?.enable !== false) {
    await exec("systemctl", [
      "--user",
      "enable",
      units.dashboard,
      units.terminalWs,
      units.directTerminalWs,
    ]);
  }

  return { units, unitDir };
}

async function getSystemdState(unit: string): Promise<string> {
  const state = await execSilent("systemctl", [
    "--user",
    "show",
    "--property=ActiveState",
    "--value",
    unit,
  ]);
  return state?.trim() || "missing";
}

async function getSystemdProcessStates(units: SystemdUnits): Promise<Record<ManagedServiceId, string>> {
  const [dashboard, terminalWs, directTerminalWs] = await Promise.all([
    getSystemdState(units.dashboard),
    getSystemdState(units.terminalWs),
    getSystemdState(units.directTerminalWs),
  ]);

  return {
    dashboard,
    "terminal-ws": terminalWs,
    "direct-terminal-ws": directTerminalWs,
  };
}

async function startSystemdServices(context: ServiceContext): Promise<void> {
  const units = getSystemdUnits(context.hash);
  await exec("systemctl", [
    "--user",
    "start",
    units.dashboard,
    units.terminalWs,
    units.directTerminalWs,
  ]);
}

async function stopSystemdServices(context: ServiceContext): Promise<void> {
  const units = getSystemdUnits(context.hash);
  await exec("systemctl", [
    "--user",
    "stop",
    units.dashboard,
    units.terminalWs,
    units.directTerminalWs,
  ]);
}

async function startSupervisor(config: OrchestratorConfig): Promise<{ started: boolean; pid: number | null }> {
  const status = getSupervisorStatus(config.configPath);
  if (status.running) {
    return { started: false, pid: status.pid };
  }

  const stateDir = getSupervisorStateDir(config.configPath);
  mkdirSync(stateDir, { recursive: true });

  const stdoutFd = openSync(status.logFile, "a");
  const stderrFd = openSync(status.logFile, "a");

  try {
    const launch = resolveSupervisorLaunch();
    const child = spawn(launch.command, launch.args, {
      cwd: process.cwd(),
      detached: true,
      stdio: ["ignore", stdoutFd, stderrFd],
      env: {
        ...process.env,
        AO_CONFIG_PATH: config.configPath,
      },
    });

    child.unref();
    if (child.pid) {
      writeFileSync(status.pidFile, `${child.pid}\n`, "utf-8");
    }
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const current = getSupervisorStatus(config.configPath);
    if (current.running) {
      return { started: true, pid: current.pid };
    }
    await sleep(100);
  }

  const final = getSupervisorStatus(config.configPath);
  if (!final.running) {
    throw new Error(`Supervisor failed to start. Check ${status.logFile}`);
  }

  return { started: true, pid: final.pid };
}

async function stopSupervisor(config: OrchestratorConfig): Promise<boolean> {
  const status = getSupervisorStatus(config.configPath);
  if (!status.running || status.pid === null) {
    clearPidFile(status.pidFile);
    return false;
  }

  try {
    process.kill(status.pid, "SIGTERM");
  } catch {
    clearPidFile(status.pidFile, status.pid);
    return false;
  }

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!isProcessRunning(status.pid)) {
      clearPidFile(status.pidFile, status.pid);
      return true;
    }
    await sleep(100);
  }

  try {
    process.kill(status.pid, "SIGKILL");
  } catch {
    // Best effort hard stop.
  }
  clearPidFile(status.pidFile, status.pid);
  return true;
}

function resolveSupervisorLaunch(): { command: string; args: string[] } {
  const entry = process.argv[1];
  const supervisorArgs = ["services", "run-supervisor"];

  if (entry && /\.(?:c|m)?js$/i.test(entry)) {
    return {
      command: process.execPath,
      args: [entry, ...supervisorArgs],
    };
  }

  if (entry && /\.ts$/i.test(entry)) {
    return {
      command: "npx",
      args: ["tsx", entry, ...supervisorArgs],
    };
  }

  return {
    command: "ao",
    args: supervisorArgs,
  };
}

async function httpProbe(
  port: number,
  path: string,
  timeoutMs = 1500,
): Promise<{ status: number | null; body: string; error: string | null }> {
  return new Promise((resolve) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "GET",
        timeout: timeoutMs,
      },
      (res) => {
        const status = res.statusCode ?? null;
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString("utf-8");
        });
        res.on("end", () => {
          resolve({ status, body, error: null });
        });
      },
    );

    req.on("timeout", () => {
      req.destroy();
      resolve({ status: null, body: "", error: "timeout" });
    });

    req.on("error", (err) => {
      resolve({ status: null, body: "", error: err.message || "request failed" });
    });

    req.end();
  });
}

function parseHealthJson(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === "object" && parsed !== null;
  } catch {
    return false;
  }
}

async function probeDashboard(port: number): Promise<ManagedServiceHealth> {
  const listening = !(await isPortAvailable(port));
  if (!listening) {
    return {
      id: "dashboard",
      port,
      listening: false,
      healthy: false,
      httpStatus: null,
      details: "no listener on port",
    };
  }

  const probe = await httpProbe(port, "/");
  const healthy = probe.error === null && probe.status !== null && probe.status >= 200 && probe.status < 500;

  return {
    id: "dashboard",
    port,
    listening,
    healthy,
    httpStatus: probe.status,
    details: probe.error ? `http error: ${probe.error}` : healthy ? "ready" : `http ${probe.status ?? "?"}`,
  };
}

async function probeTerminal(
  id: ManagedServiceId,
  port: number,
): Promise<ManagedServiceHealth> {
  const listening = !(await isPortAvailable(port));
  if (!listening) {
    return {
      id,
      port,
      listening: false,
      healthy: false,
      httpStatus: null,
      details: "no listener on port (XDA websocket backend down)",
    };
  }

  const probe = await httpProbe(port, "/health");
  const jsonOk = probe.error === null && probe.status === 200 && parseHealthJson(probe.body);
  const details = probe.error
    ? `http error: ${probe.error}`
    : probe.status !== 200
      ? `http ${probe.status ?? "?"}`
      : jsonOk
        ? "ready"
        : "invalid /health response";

  return {
    id,
    port,
    listening,
    healthy: jsonOk,
    httpStatus: probe.status,
    details,
  };
}

export async function probeManagedServices(
  ports: ServicePorts,
): Promise<ManagedServiceHealth[]> {
  const [dashboard, terminalWs, directTerminalWs] = await Promise.all([
    probeDashboard(ports.dashboard),
    probeTerminal("terminal-ws", ports.terminalWs),
    probeTerminal("direct-terminal-ws", ports.directTerminalWs),
  ]);

  return [dashboard, terminalWs, directTerminalWs];
}

export async function isSystemdUserAvailable(): Promise<boolean> {
  if (process.platform !== "linux") return false;
  const version = await execSilent("systemctl", ["--user", "--version"]);
  if (!version) return false;

  try {
    await exec("systemctl", ["--user", "show-environment"]);
    return true;
  } catch {
    return false;
  }
}

async function resolveManager(preference: ManagerPreference): Promise<ServicesManager> {
  if (preference === "systemd") {
    if (!(await isSystemdUserAvailable())) {
      throw new Error("systemd user services are not available on this host");
    }
    return "systemd";
  }

  if (preference === "supervisor") {
    return "supervisor";
  }

  if (await isSystemdUserAvailable()) {
    return "systemd";
  }

  return "supervisor";
}

function allProcessStatesReady(states: Record<ManagedServiceId, string>): boolean {
  return SERVICE_IDS.every((id) => {
    const state = states[id];
    return state === "active" || state === "running";
  });
}

export async function installManagedServices(
  config: OrchestratorConfig,
  opts?: InstallOptions,
): Promise<{ manager: ServicesManager; detail: string }> {
  const manager = await resolveManager(opts?.manager ?? "auto");
  const context = await getServiceContext(config);

  if (manager === "systemd") {
    const { units, unitDir } = await writeSystemdUnits(context, { enable: opts?.enable });
    return {
      manager,
      detail: `installed units in ${unitDir} (${units.dashboard}, ${units.terminalWs}, ${units.directTerminalWs})`,
    };
  }

  const stateDir = getSupervisorStateDir(config.configPath);
  mkdirSync(stateDir, { recursive: true });
  return { manager, detail: `supervisor state dir ready at ${stateDir}` };
}

async function getSystemdStatus(context: ServiceContext): Promise<ManagedServicesStatus> {
  const units = getSystemdUnits(context.hash);
  const processStates = await getSystemdProcessStates(units);
  const services = await probeManagedServices(context.ports);
  const managerRunning = allProcessStatesReady(processStates);
  const allReady = managerRunning && services.every((svc) => svc.healthy);

  return {
    manager: "systemd",
    managerRunning,
    managerDetail: `${units.dashboard}, ${units.terminalWs}, ${units.directTerminalWs}`,
    processStates,
    services,
    allReady,
  };
}

async function getSupervisorManagedStatus(context: ServiceContext): Promise<ManagedServicesStatus> {
  const supervisor = getSupervisorStatus(context.config.configPath);
  const services = await probeManagedServices(context.ports);
  const processState = supervisor.running ? "running" : "stopped";
  const processStates: Record<ManagedServiceId, string> = {
    dashboard: processState,
    "terminal-ws": processState,
    "direct-terminal-ws": processState,
  };
  const allReady = supervisor.running && services.every((svc) => svc.healthy);

  return {
    manager: "supervisor",
    managerRunning: supervisor.running,
    managerDetail: supervisor.running
      ? `pid ${supervisor.pid ?? "?"} (${supervisor.logFile})`
      : `not running (${supervisor.logFile})`,
    processStates,
    services,
    allReady,
  };
}

async function getStatusForManager(
  config: OrchestratorConfig,
  manager: ServicesManager,
): Promise<ManagedServicesStatus> {
  const context = await getServiceContext(config);
  if (manager === "systemd") {
    return getSystemdStatus(context);
  }
  return getSupervisorManagedStatus(context);
}

export async function getManagedServicesStatus(
  config: OrchestratorConfig,
  manager: ManagerPreference = "auto",
): Promise<ManagedServicesStatus> {
  const resolved = await resolveManager(manager);
  return getStatusForManager(config, resolved);
}

async function waitForReadyStatus(
  config: OrchestratorConfig,
  manager: ServicesManager,
  timeoutMs: number,
): Promise<ManagedServicesStatus> {
  const deadline = Date.now() + timeoutMs;
  let status = await getStatusForManager(config, manager);

  while (!status.allReady && Date.now() < deadline) {
    await sleep(500);
    status = await getStatusForManager(config, manager);
  }

  return status;
}

export async function startManagedServices(
  config: OrchestratorConfig,
  opts?: StartOptions,
): Promise<StartManagedServicesResult> {
  const preference = opts?.manager ?? "auto";
  let manager = await resolveManager(preference);
  const timeoutMs = opts?.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;

  if (manager === "systemd") {
    try {
      const context = await getServiceContext(config);
      await writeSystemdUnits(context, { enable: true });
      await startSystemdServices(context);
      const status = await waitForReadyStatus(config, "systemd", timeoutMs);
      return {
        manager: "systemd",
        started: true,
        ready: status.allReady,
        status,
      };
    } catch (err) {
      if (preference !== "auto") {
        throw err;
      }
      // Automatic fallback when systemd is present but unusable at runtime.
      manager = "supervisor";
    }
  }

  const supervisor = await startSupervisor(config);
  const status = await waitForReadyStatus(config, "supervisor", timeoutMs);
  return {
    manager,
    started: supervisor.started,
    ready: status.allReady,
    status,
  };
}

export async function stopManagedServices(
  config: OrchestratorConfig,
  opts?: StopOptions,
): Promise<{ manager: ServicesManager; stopped: boolean; status: ManagedServicesStatus }> {
  const preference = opts?.manager ?? "auto";

  if (preference === "auto") {
    if (await isSystemdUserAvailable()) {
      try {
        const context = await getServiceContext(config);
        await stopSystemdServices(context);
        const status = await getSystemdStatus(context);
        return { manager: "systemd", stopped: true, status };
      } catch {
        const stopped = await stopSupervisor(config);
        const status = await getStatusForManager(config, "supervisor");
        return { manager: "supervisor", stopped, status };
      }
    }

    const stopped = await stopSupervisor(config);
    const status = await getStatusForManager(config, "supervisor");
    return { manager: "supervisor", stopped, status };
  }

  const manager = await resolveManager(preference);
  if (manager === "systemd") {
    const context = await getServiceContext(config);
    await stopSystemdServices(context);
    const status = await getSystemdStatus(context);
    return { manager, stopped: true, status };
  }

  const stopped = await stopSupervisor(config);
  const status = await getStatusForManager(config, "supervisor");
  return { manager, stopped, status };
}

interface SupervisorProcessSpec {
  id: ManagedServiceId;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

function buildSupervisorSpecs(context: ServiceContext): SupervisorProcessSpec[] {
  const shared = {
    AO_CONFIG_PATH: context.config.configPath,
    PORT: String(context.ports.dashboard),
    TERMINAL_PORT: String(context.ports.terminalWs),
    DIRECT_TERMINAL_PORT: String(context.ports.directTerminalWs),
    NEXT_PUBLIC_TERMINAL_PORT: String(context.ports.terminalWs),
    NEXT_PUBLIC_DIRECT_TERMINAL_PORT: String(context.ports.directTerminalWs),
  };

  return [
    {
      id: "dashboard",
      command: "npm",
      args: ["run", "start:dashboard"],
      cwd: context.webDir,
      env: shared,
    },
    {
      id: "terminal-ws",
      command: "npm",
      args: ["run", "start:terminal"],
      cwd: context.webDir,
      env: shared,
    },
    {
      id: "direct-terminal-ws",
      command: "npm",
      args: ["run", "start:direct-terminal"],
      cwd: context.webDir,
      env: shared,
    },
  ];
}

export async function runSupervisorLoop(config: OrchestratorConfig): Promise<void> {
  const context = await getServiceContext(config);
  const specs = buildSupervisorSpecs(context);
  const children = new Map<ManagedServiceId, ChildProcess>();
  const restartCounters = new Map<ManagedServiceId, number>();
  let shuttingDown = false;

  const maybeExit = () => {
    if (shuttingDown && children.size === 0) {
      clearPidFile(getSupervisorPidFile(config.configPath), process.pid);
      process.exit(0);
    }
  };

  const scheduleRestart = (spec: SupervisorProcessSpec, reason: string) => {
    const retries = (restartCounters.get(spec.id) ?? 0) + 1;
    restartCounters.set(spec.id, retries);
    const delayMs = Math.min(15_000, 500 * 2 ** Math.min(retries, 5));
    console.error(`[ao-services] ${spec.id} ${reason}; restarting in ${delayMs}ms`);
    const timer = setTimeout(() => {
      if (!shuttingDown) {
        startSpec(spec);
      }
    }, delayMs);
    timer.unref();
  };

  const startSpec = (spec: SupervisorProcessSpec) => {
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      stdio: "inherit",
      env: {
        ...process.env,
        ...spec.env,
      },
    });

    children.set(spec.id, child);
    let settled = false;

    const onExitLike = (message: string) => {
      if (settled) return;
      settled = true;
      if (children.get(spec.id) === child) {
        children.delete(spec.id);
      }
      if (shuttingDown) {
        maybeExit();
        return;
      }
      scheduleRestart(spec, message);
    };

    child.once("exit", (code, signal) => {
      onExitLike(`exited (code=${code ?? "null"}, signal=${signal ?? "null"})`);
    });

    child.once("error", (err) => {
      onExitLike(`errored (${err.message})`);
    });
  };

  const handleShutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[ao-services] received ${signal}; shutting down managed services`);
    for (const [, child] of children) {
      try {
        child.kill("SIGTERM");
      } catch {
        // Best effort.
      }
    }

    const forceTimer = setTimeout(() => {
      for (const [, child] of children) {
        try {
          child.kill("SIGKILL");
        } catch {
          // Best effort.
        }
      }
      clearPidFile(getSupervisorPidFile(config.configPath), process.pid);
      process.exit(0);
    }, 5000);
    forceTimer.unref();

    maybeExit();
  };

  process.on("SIGINT", () => handleShutdown("SIGINT"));
  process.on("SIGTERM", () => handleShutdown("SIGTERM"));

  writeFileSync(getSupervisorPidFile(config.configPath), `${process.pid}\n`, "utf-8");

  for (const spec of specs) {
    startSpec(spec);
  }

  await new Promise<void>(() => {
    // Keep event loop alive until a signal arrives.
  });
}
