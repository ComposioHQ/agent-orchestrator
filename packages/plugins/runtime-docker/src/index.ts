import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  AttachInfo,
  PluginModule,
  Runtime,
  RuntimeCreateConfig,
  RuntimeHandle,
  RuntimeMetrics,
} from "@composio/ao-core";

const execFileAsync = promisify(execFile);
const DOCKER_TIMEOUT_MS = 30_000;
const SAFE_SESSION_ID = /^[a-zA-Z0-9_.-]+$/;
const READ_ONLY_MODES = new Set(["ro"]);

export interface DockerRuntimeConfig {
  image: string;
  shell: string;
  mountHome: boolean;
  mounts: string[];
  env: Record<string, string>;
  passHostEnv: string[];
  extraArgs: string[];
  user?: string;
}

export const manifest = {
  name: "docker",
  slot: "runtime" as const,
  description: "Runtime plugin: Docker containers",
  version: "0.1.0",
};

function assertValidSessionId(id: string): void {
  if (!SAFE_SESSION_ID.test(id)) {
    throw new Error(`Invalid session ID "${id}": must match ${SAFE_SESSION_ID}`);
  }
}

function expandHomePath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

function normalizeEnvMap(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object") return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") {
      result[key] = value;
    }
  }
  return result;
}

function normalizeStringArray(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input.filter((value): value is string => typeof value === "string" && value.length > 0);
}

function detectHostUser(): string | undefined {
  if (typeof process.getuid !== "function" || typeof process.getgid !== "function") {
    return undefined;
  }
  return `${process.getuid()}:${process.getgid()}`;
}

export function normalizeDockerRuntimeConfig(
  runtimeConfig?: Record<string, unknown>,
): DockerRuntimeConfig {
  const image = typeof runtimeConfig?.["image"] === "string" ? runtimeConfig["image"].trim() : "";
  if (image.length === 0) {
    throw new Error(
      "Docker runtime requires project.runtimeConfig.image (for example, ghcr.io/your-org/ao-agent:latest)",
    );
  }

  const shell =
    typeof runtimeConfig?.["shell"] === "string" && runtimeConfig["shell"].trim().length > 0
      ? runtimeConfig["shell"].trim()
      : "/bin/sh";

  const mountHome = runtimeConfig?.["mountHome"] !== false;
  const env = normalizeEnvMap(runtimeConfig?.["env"]);
  const passHostEnv = normalizeStringArray(runtimeConfig?.["passHostEnv"]);
  const extraArgs = normalizeStringArray(runtimeConfig?.["extraArgs"]);
  const mounts = normalizeStringArray(runtimeConfig?.["mounts"]).map((entry) =>
    entry.replace(/^~(?=\/|$)/, homedir()),
  );
  const configuredUser =
    typeof runtimeConfig?.["user"] === "string" && runtimeConfig["user"].trim().length > 0
      ? runtimeConfig["user"].trim()
      : undefined;

  return {
    image,
    shell,
    mountHome,
    mounts,
    env,
    passHostEnv,
    extraArgs,
    user: configuredUser ?? detectHostUser(),
  };
}

function toVolumeArg(spec: string): string {
  const parts = spec.split(":");
  if (parts.length < 2 || parts.length > 3) {
    throw new Error(`Invalid Docker mount "${spec}". Expected SOURCE:TARGET[:ro|rw].`);
  }

  const source = expandHomePath(parts[0] ?? "");
  const target = expandHomePath(parts[1] ?? "");
  const mode = parts[2];

  if (!source.startsWith("/")) {
    throw new Error(`Docker mount source must be an absolute path: "${spec}"`);
  }
  if (!target.startsWith("/")) {
    throw new Error(`Docker mount target must be an absolute path: "${spec}"`);
  }
  if (mode && mode !== "rw" && !READ_ONLY_MODES.has(mode)) {
    throw new Error(`Unsupported Docker mount mode "${mode}" in "${spec}"`);
  }

  return mode ? `${source}:${target}:${mode}` : `${source}:${target}`;
}

async function docker(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, {
    timeout: DOCKER_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trimEnd();
}

async function dockerExists(containerName: string): Promise<boolean> {
  try {
    await docker(["inspect", containerName]);
    return true;
  } catch {
    return false;
  }
}

async function removeContainer(containerName: string): Promise<void> {
  try {
    await docker(["rm", "-f", containerName]);
  } catch {
    // Best effort cleanup
  }
}

function buildContainerEnv(
  launchConfig: RuntimeCreateConfig,
  runtimeConfig: DockerRuntimeConfig,
): Record<string, string> {
  const env: Record<string, string> = {
    ...runtimeConfig.env,
    ...launchConfig.environment,
    TERM: process.env["TERM"] ?? "xterm-256color",
  };

  for (const key of runtimeConfig.passHostEnv) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }

  if (runtimeConfig.mountHome && !("HOME" in env)) {
    env["HOME"] = homedir();
  }

  return env;
}

function createAttachCommand(handle: RuntimeHandle): string {
  return `docker attach ${handle.id}`;
}

export function create(): Runtime {
  return {
    name: "docker",

    async create(config: RuntimeCreateConfig): Promise<RuntimeHandle> {
      assertValidSessionId(config.sessionId);

      const runtimeConfig = normalizeDockerRuntimeConfig(config.runtimeConfig);
      const containerName = config.sessionId;
      const env = buildContainerEnv(config, runtimeConfig);
      const workspacePath = expandHomePath(config.workspacePath);
      const volumeArgs = ["-v", `${workspacePath}:${workspacePath}`];

      if (runtimeConfig.mountHome) {
        const home = homedir();
        volumeArgs.push("-v", `${home}:${home}`);
      }

      for (const mount of runtimeConfig.mounts) {
        volumeArgs.push("-v", toVolumeArg(mount));
      }

      if (await dockerExists(containerName)) {
        await removeContainer(containerName);
      }

      const args = [
        "run",
        "--detach",
        "--interactive",
        "--tty",
        "--name",
        containerName,
        "--workdir",
        workspacePath,
      ];

      if (runtimeConfig.user) {
        args.push("--user", runtimeConfig.user);
      }

      for (const [key, value] of Object.entries(env)) {
        args.push("-e", `${key}=${value}`);
      }

      args.push(...volumeArgs);
      args.push(...runtimeConfig.extraArgs);
      args.push(runtimeConfig.image, runtimeConfig.shell, "-lc", config.launchCommand);

      try {
        await docker(args);
      } catch (err) {
        await removeContainer(containerName);
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to start Docker container "${containerName}": ${message}`, {
          cause: err,
        });
      }

      return {
        id: containerName,
        runtimeName: "docker",
        data: {
          createdAt: Date.now(),
          image: runtimeConfig.image,
          shell: runtimeConfig.shell,
          workspacePath,
        },
      };
    },

    async destroy(handle: RuntimeHandle): Promise<void> {
      await removeContainer(handle.id);
    },

    async sendMessage(handle: RuntimeHandle, message: string): Promise<void> {
      const shell =
        typeof handle.data["shell"] === "string" && handle.data["shell"].length > 0
          ? String(handle.data["shell"])
          : "/bin/sh";

      const child = spawn("docker", ["exec", "-i", handle.id, shell, "-lc", "cat > /proc/1/fd/0"], {
        stdio: ["pipe", "pipe", "pipe"],
      });

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (err?: Error | null) => {
          if (settled) return;
          settled = true;
          if (err) reject(err);
          else resolve();
        };

        child.once("error", (err) => finish(err));
        child.once("exit", (code) => {
          if (code === 0 || code === null) {
            finish();
          } else {
            finish(new Error(`docker exec exited with code ${code}`));
          }
        });

        child.stdin?.write(message.endsWith("\n") ? message : `${message}\n`, (err) => {
          if (err) {
            finish(err);
            return;
          }
          child.stdin?.end();
        });
      });
    },

    async getOutput(handle: RuntimeHandle, lines = 50): Promise<string> {
      try {
        return await docker(["logs", "--tail", String(lines), handle.id]);
      } catch {
        return "";
      }
    },

    async isAlive(handle: RuntimeHandle): Promise<boolean> {
      try {
        const output = await docker(["inspect", "-f", "{{.State.Running}}", handle.id]);
        return output.trim() === "true";
      } catch {
        return false;
      }
    },

    async getMetrics(handle: RuntimeHandle): Promise<RuntimeMetrics> {
      const createdAt = (handle.data["createdAt"] as number) ?? Date.now();
      return {
        uptimeMs: Date.now() - createdAt,
      };
    },

    async getAttachInfo(handle: RuntimeHandle): Promise<AttachInfo> {
      return {
        type: "docker",
        target: handle.id,
        command: createAttachCommand(handle),
      };
    },
  };
}

export default { manifest, create } satisfies PluginModule<Runtime>;
