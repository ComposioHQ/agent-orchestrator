import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import type {
  AgentDockerRuntimeHints,
  AttachInfo,
  PluginModule,
  Runtime,
  RuntimeCreateConfig,
  RuntimeHandle,
  RuntimeMetrics,
} from "@composio/ao-core";

const execFileAsync = promisify(execFile);
const DOCKER_COMMAND_TIMEOUT_MS = 30_000;
const SAFE_SESSION_ID = /^[a-zA-Z0-9_-]+$/;
const LONG_MESSAGE_THRESHOLD = 200;
const CONTAINER_AO_BIN_DIR = "/tmp/ao/bin";
const CONTAINER_AO_DATA_DIR = "/tmp/ao/data";
const CONTAINER_HOME_DIR = "/tmp/ao-home";
const CONTAINER_RUNTIME_DIR = "/tmp/ao/runtime";
const AO_METADATA_HELPER = "ao-metadata-helper.sh";

export const manifest = {
  name: "docker",
  slot: "runtime" as const,
  description: "Runtime plugin: Docker containers with tmux-backed interactive sessions",
  version: "0.1.0",
};

interface DockerRuntimeConfig {
  image?: string;
  shell?: string;
  user?: string;
  network?: string;
  readOnlyRoot?: boolean;
  capDrop?: string[];
  tmpfs?: string[];
  limits?: {
    cpus?: number | string;
    memory?: string;
    gpus?: string;
  };
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readOnly?: boolean;
}

function assertValidSessionId(id: string): void {
  if (!SAFE_SESSION_ID.test(id)) {
    throw new Error(`Invalid session ID "${id}": must match ${SAFE_SESSION_ID}`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDockerRuntimeConfig(config?: Record<string, unknown>): DockerRuntimeConfig {
  return isPlainObject(config) ? (config as DockerRuntimeConfig) : {};
}

function hasTmpfsTarget(runtimeConfig: DockerRuntimeConfig, target: string): boolean {
  return (runtimeConfig.tmpfs ?? []).some((mount) => mount.split(":")[0]?.trim() === target);
}

function validateDockerRuntimeConfig(runtimeConfig: DockerRuntimeConfig): void {
  if (!runtimeConfig.image) {
    throw new Error("Docker runtime requires runtimeConfig.image");
  }

  if (runtimeConfig.readOnlyRoot && !hasTmpfsTarget(runtimeConfig, "/tmp")) {
    throw new Error(
      "Docker runtime with readOnlyRoot=true requires tmpfs to include /tmp so tmux and agent CLIs can create runtime state.",
    );
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function pathIsFile(path: string): boolean {
  try {
    return existsSync(path) && lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function pathIsDirectory(path: string): boolean {
  try {
    return existsSync(path) && lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function parsePathEntries(value?: string): string[] {
  return (value ?? "").split(":").filter(Boolean);
}

function rewritePathEntries(
  value: string | undefined,
  replacements: Map<string, string>,
): string | undefined {
  if (!value) return undefined;

  const entries: string[] = [];
  const seen = new Set<string>();
  for (const entry of parsePathEntries(value)) {
    const next = replacements.get(entry) ?? entry;
    if (!next || seen.has(next)) continue;
    entries.push(next);
    seen.add(next);
  }

  return entries.length > 0 ? entries.join(":") : undefined;
}

function dedupeMounts(mounts: VolumeMount[]): VolumeMount[] {
  const deduped = new Map<string, VolumeMount>();
  for (const mount of mounts) {
    if (!mount.hostPath || !mount.containerPath) continue;
    deduped.set(`${mount.hostPath}->${mount.containerPath}`, mount);
  }
  return [...deduped.values()];
}

function rewriteMountedPathsInCommand(command: string, mounts: VolumeMount[]): string {
  const rewrites = mounts
    .filter((mount) => mount.hostPath && mount.containerPath && mount.hostPath !== mount.containerPath)
    .sort((left, right) => right.hostPath.length - left.hostPath.length);

  let rewritten = command;
  for (const mount of rewrites) {
    rewritten = rewritten.split(mount.hostPath).join(mount.containerPath);
  }
  return rewritten;
}

function findWrapperDir(pathValue?: string): string | undefined {
  for (const entry of parsePathEntries(pathValue)) {
    if (pathIsFile(join(entry, AO_METADATA_HELPER))) {
      return entry;
    }
  }
  return undefined;
}

function resolveExternalGitCommonDir(workspacePath: string): string | undefined {
  const gitPath = join(workspacePath, ".git");
  if (!pathIsFile(gitPath)) return undefined;

  let rawGitDir: string;
  try {
    rawGitDir = readFileSync(gitPath, "utf-8").trim();
  } catch {
    return undefined;
  }

  const match = rawGitDir.match(/^gitdir:\s*(.+)\s*$/i);
  if (!match) return undefined;

  const gitDir = resolve(workspacePath, match[1]);
  const commonDirFile = join(gitDir, "commondir");
  if (!pathIsFile(commonDirFile)) {
    return gitDir;
  }

  try {
    const commonDir = readFileSync(commonDirFile, "utf-8").trim();
    return commonDir ? resolve(gitDir, commonDir) : gitDir;
  } catch {
    return gitDir;
  }
}

function getWorkspaceMounts(workspacePath: string): VolumeMount[] {
  const mounts: VolumeMount[] = [{ hostPath: workspacePath, containerPath: workspacePath }];
  const gitCommonDir = resolveExternalGitCommonDir(workspacePath);
  if (gitCommonDir) {
    mounts.push({ hostPath: gitCommonDir, containerPath: gitCommonDir });
  }
  return dedupeMounts(mounts);
}

function resolveHomePath(basePath: string, requestedPath: string): string {
  return requestedPath.startsWith("/") ? requestedPath : join(basePath, requestedPath);
}

function getAgentHomeMounts(
  hints: AgentDockerRuntimeHints | undefined,
  containerHome: string,
): VolumeMount[] {
  if (!hints?.homeMounts?.length) {
    return [];
  }

  const hostHome = homedir();
  const mounts: VolumeMount[] = [];
  for (const mount of hints.homeMounts) {
    const hostPath = resolveHomePath(hostHome, mount.path);
    const hostPathExists = pathIsDirectory(hostPath) || pathIsFile(hostPath);
    if (!hostPathExists) {
      try {
        if (mount.kind === "dir") {
          mkdirSync(hostPath, { recursive: true });
        } else if (mount.kind === "file") {
          mkdirSync(dirname(hostPath), { recursive: true });
          writeFileSync(hostPath, "", { flag: "a", mode: 0o600 });
        } else {
          continue;
        }
      } catch {
        continue;
      }
    }

    if (!pathIsDirectory(hostPath) && !pathIsFile(hostPath) && mount.kind === undefined) {
      continue;
    }

    mounts.push({
      hostPath,
      containerPath: resolveHomePath(containerHome, mount.target ?? mount.path),
      readOnly: mount.readOnly,
    });
  }

  return mounts;
}

function applyHostEnvironmentHints(
  environment: Record<string, string>,
  hints: AgentDockerRuntimeHints | undefined,
): Record<string, string> {
  if (!hints?.envFromHost?.length) {
    return environment;
  }

  const prepared = { ...environment };
  for (const key of hints.envFromHost) {
    if (!key || prepared[key] !== undefined) continue;
    const value = process.env[key];
    if (value !== undefined) {
      prepared[key] = value;
    }
  }

  return prepared;
}

function applyContainerEnvironmentDefaults(
  environment: Record<string, string>,
  hints: AgentDockerRuntimeHints | undefined,
  containerHome: string,
): Record<string, string> {
  if (!hints?.envDefaults || Object.keys(hints.envDefaults).length === 0) {
    return environment;
  }

  const prepared = { ...environment };
  for (const [key, value] of Object.entries(hints.envDefaults)) {
    if (!key || !value || prepared[key] !== undefined) continue;
    prepared[key] = value.startsWith("/") ? value : resolveHomePath(containerHome, value);
  }

  return prepared;
}

function prepareContainerEnvironment(
  environment: Record<string, string>,
  hints?: AgentDockerRuntimeHints,
): {
  environment: Record<string, string>;
  mounts: VolumeMount[];
} {
  const prepared = applyHostEnvironmentHints(environment, hints);
  const mounts: VolumeMount[] = [];
  const containerHome = prepared["HOME"] || CONTAINER_HOME_DIR;
  prepared["HOME"] = containerHome;
  const containerEnv = applyContainerEnvironmentDefaults(prepared, hints, containerHome);

  const wrapperDir = findWrapperDir(containerEnv["PATH"]);
  if (wrapperDir && pathIsDirectory(wrapperDir)) {
    mounts.push({
      hostPath: wrapperDir,
      containerPath: CONTAINER_AO_BIN_DIR,
      readOnly: true,
    });
    const rewrittenPath = rewritePathEntries(
      containerEnv["PATH"],
      new Map([[wrapperDir, CONTAINER_AO_BIN_DIR]]),
    );
    if (rewrittenPath) {
      containerEnv["PATH"] = rewrittenPath;
    }
  }

  const aoDataDir = containerEnv["AO_DATA_DIR"];
  if (aoDataDir && pathIsDirectory(aoDataDir)) {
    mounts.push({ hostPath: aoDataDir, containerPath: CONTAINER_AO_DATA_DIR });
    containerEnv["AO_DATA_DIR"] = CONTAINER_AO_DATA_DIR;
  }

  const hostHome = homedir();
  const agentHomeMounts = getAgentHomeMounts(hints, containerHome);
  if (agentHomeMounts.length > 0) {
    mounts.push(...agentHomeMounts);
  }

  const hostGitConfig = join(hostHome, ".gitconfig");
  if (pathIsFile(hostGitConfig)) {
    mounts.push({
      hostPath: hostGitConfig,
      containerPath: join(containerHome, ".gitconfig"),
      readOnly: true,
    });
  }

  const hostGitCredentials = join(hostHome, ".git-credentials");
  if (pathIsFile(hostGitCredentials)) {
    mounts.push({
      hostPath: hostGitCredentials,
      containerPath: join(containerHome, ".git-credentials"),
      readOnly: true,
    });
  }

  const hostGhConfigDir = join(hostHome, ".config", "gh");
  if (pathIsDirectory(hostGhConfigDir)) {
    mounts.push({
      hostPath: hostGhConfigDir,
      containerPath: join(containerHome, ".config", "gh"),
    });
  }

  // GH_PATH is host-resolved by the agent plugin and often invalid in-container.
  delete containerEnv["GH_PATH"];

  return { environment: containerEnv, mounts: dedupeMounts(mounts) };
}

function toVolumeArg(mount: VolumeMount): string {
  return mount.readOnly
    ? `${mount.hostPath}:${mount.containerPath}:ro`
    : `${mount.hostPath}:${mount.containerPath}`;
}

function collectContainerHomeDirs(containerHome: string, mounts: VolumeMount[]): string[] {
  const dirs = new Set<string>([
    containerHome,
    join(containerHome, ".cache"),
    join(containerHome, ".config"),
    join(containerHome, ".local"),
    join(containerHome, ".local", "share"),
    join(containerHome, ".local", "state"),
  ]);

  for (const mount of mounts) {
    if (!mount.containerPath.startsWith(containerHome)) continue;
    let current = dirname(mount.containerPath);
    while (current.startsWith(containerHome) && current.length >= containerHome.length) {
      dirs.add(current);
      if (current === containerHome) break;
      current = dirname(current);
    }
  }

  return [...dirs].sort();
}

async function docker(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, {
    timeout: DOCKER_COMMAND_TIMEOUT_MS,
  });
  return stdout.trimEnd();
}

async function dockerExec(
  containerName: string,
  args: string[],
  execUser?: string,
): Promise<string> {
  const execArgs = ["exec"];
  if (execUser) {
    execArgs.push("--user", execUser);
  }
  execArgs.push(containerName, ...args);
  return docker(execArgs);
}

async function dockerTmux(
  containerName: string,
  args: string[],
  execUser?: string,
): Promise<string> {
  return dockerExec(containerName, ["tmux", ...args], execUser);
}

function getDefaultDockerUser(): string | undefined {
  if (typeof process.getuid === "function" && typeof process.getgid === "function") {
    return `${process.getuid()}:${process.getgid()}`;
  }
  return undefined;
}

function getContainerName(handle: RuntimeHandle): string {
  const containerName = handle.data["containerName"];
  return typeof containerName === "string" && containerName.length > 0 ? containerName : handle.id;
}

function getTmuxSessionName(handle: RuntimeHandle): string {
  const tmuxSessionName = handle.data["tmuxSessionName"];
  return typeof tmuxSessionName === "string" && tmuxSessionName.length > 0
    ? tmuxSessionName
    : handle.id;
}

function getExecUser(handle: RuntimeHandle): string | undefined {
  const execUser = handle.data["execUser"];
  return typeof execUser === "string" && execUser.length > 0 ? execUser : undefined;
}

function parseCpuPercent(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/%$/, "");
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseMemoryMb(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const usage = value.split("/")[0]?.trim();
  if (!usage) return undefined;

  const match = usage.match(/^([0-9]+(?:\.[0-9]+)?)\s*([A-Za-z]+)$/);
  if (!match) return undefined;

  const amount = Number.parseFloat(match[1]);
  if (!Number.isFinite(amount)) return undefined;

  const unit = match[2];
  const multipliers: Record<string, number> = {
    B: 1 / 1_000_000,
    kB: 1 / 1_000,
    KB: 1 / 1_000,
    KiB: 1 / 1024,
    MB: 1,
    MiB: 1,
    GB: 1_000,
    GiB: 1024,
    TB: 1_000_000,
    TiB: 1_048_576,
  };

  const multiplier = multipliers[unit];
  if (multiplier === undefined) return undefined;
  return Number.parseFloat((amount * multiplier).toFixed(2));
}

async function getDockerStats(
  containerName: string,
): Promise<Pick<RuntimeMetrics, "cpuPercent" | "memoryMb">> {
  try {
    const output = await docker(["stats", "--no-stream", "--format", "{{json .}}", containerName]);
    const parsed = JSON.parse(output) as Record<string, unknown>;
    return {
      cpuPercent: parseCpuPercent(parsed["CPUPerc"]),
      memoryMb: parseMemoryMb(parsed["MemUsage"]),
    };
  } catch {
    return {};
  }
}

async function removeContainer(containerName: string): Promise<void> {
  try {
    await docker(["rm", "-f", containerName]);
  } catch {
    // Best-effort cleanup
  }
}

async function sendTextToTmux(
  containerName: string,
  tmuxSessionName: string,
  hostBufferDir: string,
  containerBufferDir: string,
  execUser: string | undefined,
  text: string,
  clearInput = true,
): Promise<void> {
  if (clearInput) {
    await dockerTmux(containerName, ["send-keys", "-t", tmuxSessionName, "C-u"], execUser);
    await sleep(200);
  }

  if (text.includes("\n") || text.length > LONG_MESSAGE_THRESHOLD) {
    const bufferName = `ao-${randomUUID()}`;
    const hostTmpPath = join(hostBufferDir, `.ao-tmux-buffer-${randomUUID()}.txt`);
    const containerTmpPath = join(containerBufferDir, basename(hostTmpPath));
    writeFileSync(hostTmpPath, text, { encoding: "utf-8", mode: 0o600 });
    try {
      await dockerTmux(containerName, ["load-buffer", "-b", bufferName, containerTmpPath], execUser);
      await dockerTmux(containerName, [
        "paste-buffer",
        "-b",
        bufferName,
        "-t",
        tmuxSessionName,
        "-d",
      ], execUser);
    } finally {
      try {
        unlinkSync(hostTmpPath);
      } catch {
        // ignore cleanup failure
      }
      await dockerTmux(containerName, ["delete-buffer", "-b", bufferName], execUser).catch(
        () => undefined,
      );
    }
  } else {
    await dockerTmux(containerName, ["send-keys", "-t", tmuxSessionName, "-l", text], execUser);
  }

  await sleep(300);
  await dockerTmux(containerName, ["send-keys", "-t", tmuxSessionName, "Enter"], execUser);
}

export function create(): Runtime {
  return {
    name: "docker",

    async create(config: RuntimeCreateConfig): Promise<RuntimeHandle> {
      assertValidSessionId(config.sessionId);

      const runtimeConfig = parseDockerRuntimeConfig(config.runtimeConfig);
      validateDockerRuntimeConfig(runtimeConfig);
      const image = runtimeConfig.image;
      if (!image) {
        throw new Error("Docker runtime requires runtimeConfig.image");
      }

      const containerName = config.sessionId;
      const tmuxSessionName = config.sessionId;
      const shell = runtimeConfig.shell ?? "/bin/sh";
      const execUser = runtimeConfig.user ?? getDefaultDockerUser();
      const hostRuntimeDir = mkdtempSync(join(tmpdir(), `ao-runtime-docker-${config.sessionId}-`));
      const preparedEnvironment = prepareContainerEnvironment(
        config.environment ?? {},
        config.agentRuntimeHints?.docker,
      );
      const mounts = dedupeMounts([
        ...getWorkspaceMounts(config.workspacePath),
        ...preparedEnvironment.mounts,
        { hostPath: hostRuntimeDir, containerPath: CONTAINER_RUNTIME_DIR },
      ]);
      const launchCommand = rewriteMountedPathsInCommand(config.launchCommand, mounts);

      const runArgs = ["run", "-d", "--name", containerName, "--workdir", config.workspacePath];

      for (const mount of mounts) {
        runArgs.push("--volume", toVolumeArg(mount));
      }
      for (const [key, value] of Object.entries(preparedEnvironment.environment)) {
        runArgs.push("--env", `${key}=${value}`);
      }
      if (execUser) {
        runArgs.push("--user", execUser);
      }
      if (runtimeConfig.network) {
        runArgs.push("--network", runtimeConfig.network);
      }
      if (runtimeConfig.readOnlyRoot) {
        runArgs.push("--read-only");
      }
      for (const cap of runtimeConfig.capDrop ?? []) {
        runArgs.push("--cap-drop", cap);
      }
      for (const mount of runtimeConfig.tmpfs ?? []) {
        runArgs.push("--tmpfs", mount);
      }
      if (runtimeConfig.limits?.cpus !== undefined) {
        runArgs.push("--cpus", String(runtimeConfig.limits.cpus));
      }
      if (runtimeConfig.limits?.memory) {
        runArgs.push("--memory", runtimeConfig.limits.memory);
      }
      if (runtimeConfig.limits?.gpus) {
        runArgs.push("--gpus", runtimeConfig.limits.gpus);
      }

      runArgs.push(
        image,
        shell,
        "-lc",
        'mkdir -p "$HOME"; trap \'exit 0\' TERM INT; while :; do sleep 3600; done',
      );

      try {
        await docker(runArgs);
        const homeDirs = collectContainerHomeDirs(
          preparedEnvironment.environment["HOME"] || CONTAINER_HOME_DIR,
          mounts,
        );
        const mkdirArgs = homeDirs.map((dir) => shellQuote(dir)).join(" ");
        const homeInitCommand = execUser
          ? [
            `mkdir -p ${mkdirArgs}`,
            `chown ${shellQuote(execUser)} ${mkdirArgs} 2>/dev/null || true`,
          ].join("; ")
          : `mkdir -p ${mkdirArgs}`;
        await dockerExec(containerName, [shell, "-lc", homeInitCommand], execUser ? "0:0" : undefined);
        const envArgs: string[] = [];
        for (const [key, value] of Object.entries(preparedEnvironment.environment)) {
          envArgs.push("-e", `${key}=${value}`);
        }
        await dockerTmux(containerName, [
          "new-session",
          "-d",
          "-s",
          tmuxSessionName,
          "-c",
          config.workspacePath,
          ...envArgs,
        ], execUser);
        await sendTextToTmux(
          containerName,
          tmuxSessionName,
          hostRuntimeDir,
          CONTAINER_RUNTIME_DIR,
          execUser,
          launchCommand,
          false,
        );
      } catch (err) {
        await removeContainer(containerName);
        rmSync(hostRuntimeDir, { recursive: true, force: true });
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Failed to create docker runtime for session "${config.sessionId}": ${msg}`,
          {
            cause: err,
          },
        );
      }

      return {
        id: containerName,
        runtimeName: "docker",
        data: {
          containerName,
          tmuxSessionName,
          workspacePath: config.workspacePath,
          hostRuntimeDir,
          execUser,
          createdAt: Date.now(),
        },
      };
    },

    async destroy(handle: RuntimeHandle): Promise<void> {
      await removeContainer(getContainerName(handle));
      const hostRuntimeDir = handle.data["hostRuntimeDir"];
      if (typeof hostRuntimeDir === "string" && hostRuntimeDir.length > 0) {
        rmSync(hostRuntimeDir, { recursive: true, force: true });
      }
    },

    async sendMessage(handle: RuntimeHandle, message: string): Promise<void> {
      const hostRuntimeDir = handle.data["hostRuntimeDir"];
      await sendTextToTmux(
        getContainerName(handle),
        getTmuxSessionName(handle),
        typeof hostRuntimeDir === "string" && hostRuntimeDir.length > 0
          ? hostRuntimeDir
          : (handle.data["workspacePath"] as string),
        CONTAINER_RUNTIME_DIR,
        getExecUser(handle),
        message,
        true,
      );
    },

    async getOutput(handle: RuntimeHandle, lines = 50): Promise<string> {
      try {
        return await dockerTmux(getContainerName(handle), [
          "capture-pane",
          "-t",
          getTmuxSessionName(handle),
          "-p",
          "-S",
          `-${lines}`,
        ], getExecUser(handle));
      } catch {
        return "";
      }
    },

    async isAlive(handle: RuntimeHandle): Promise<boolean> {
      try {
        const output = await docker([
          "inspect",
          "-f",
          "{{.State.Running}}",
          getContainerName(handle),
        ]);
        return output.trim() === "true";
      } catch {
        return false;
      }
    },

    async getMetrics(handle: RuntimeHandle): Promise<RuntimeMetrics> {
      const createdAt = (handle.data["createdAt"] as number) ?? Date.now();
      return {
        uptimeMs: Date.now() - createdAt,
        ...(await getDockerStats(getContainerName(handle))),
      };
    },

    async getAttachInfo(handle: RuntimeHandle): Promise<AttachInfo> {
      const containerName = getContainerName(handle);
      const tmuxSessionName = getTmuxSessionName(handle);
      const execUser = getExecUser(handle);
      const attachArgs = [
        "exec",
        "-it",
        ...(execUser ? ["--user", execUser] : []),
        containerName,
        "tmux",
        "attach",
        "-t",
        tmuxSessionName,
      ];
      return {
        type: "docker",
        target: containerName,
        command: ["docker", ...attachArgs].join(" "),
        program: "docker",
        args: attachArgs,
        requiresPty: true,
      };
    },
  };
}

export default { manifest, create } satisfies PluginModule<Runtime>;
