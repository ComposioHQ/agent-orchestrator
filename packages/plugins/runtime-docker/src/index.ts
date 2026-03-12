import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  shellEscape,
  type PluginModule,
  type Runtime,
  type RuntimeCreateConfig,
  type RuntimeHandle,
  type RuntimeMetrics,
  type AttachInfo,
} from "@composio/ao-core";

const execFileAsync = promisify(execFile);

export const manifest = {
  name: "docker",
  slot: "runtime" as const,
  description: "Runtime plugin: Docker containers",
  version: "0.1.0",
};

/** Only allow safe characters in container names */
const SAFE_CONTAINER_NAME = /^[a-zA-Z0-9_-]+$/;

function assertValidContainerName(id: string): void {
  if (!SAFE_CONTAINER_NAME.test(id)) {
    throw new Error(
      `Invalid container name "${id}": must match ${SAFE_CONTAINER_NAME}`,
    );
  }
}

/** Run a docker command and return stdout */
async function docker(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, {
    timeout: 30_000,
  });
  return stdout.trimEnd();
}

export function create(config?: Record<string, unknown>): Runtime {
  const image = (config?.image as string) ?? "node:20-slim";

  return {
    name: "docker",

    async create(cfg: RuntimeCreateConfig): Promise<RuntimeHandle> {
      assertValidContainerName(cfg.sessionId);
      const containerName = cfg.sessionId;

      // Build environment flags: -e KEY=VALUE for each env var
      const envArgs: string[] = [];
      for (const [key, value] of Object.entries(cfg.environment ?? {})) {
        envArgs.push("-e", `${key}=${value}`);
      }

      // Create the container
      await docker(
        "create",
        "--name",
        containerName,
        "-w",
        "/workspace",
        "-v",
        `${cfg.workspacePath}:/workspace`,
        ...envArgs,
        image,
        "sleep",
        "infinity",
      );

      // Start the container
      await docker("start", containerName);

      // Run the launch command in the background inside the container
      await execFileAsync(
        "docker",
        ["exec", "-d", containerName, "sh", "-c", cfg.launchCommand],
        { timeout: 30_000 },
      );

      return {
        id: containerName,
        runtimeName: "docker",
        data: {
          createdAt: Date.now(),
          workspacePath: cfg.workspacePath,
          image,
        },
      };
    },

    async destroy(handle: RuntimeHandle): Promise<void> {
      try {
        await docker("rm", "-f", handle.id);
      } catch {
        // Container may already be removed -- that's fine
      }
    },

    async sendMessage(handle: RuntimeHandle, message: string): Promise<void> {
      // Append the message to /tmp/ao-input inside the container so the
      // running agent can read it (consistent with podman/lxc/nspawn/k8s).
      await execFileAsync(
        "docker",
        [
          "exec",
          handle.id,
          "sh",
          "-c",
          `printf '%s\\n' ${shellEscape(message)} >> /tmp/ao-input`,
        ],
        { timeout: 30_000 },
      );
    },

    async getOutput(handle: RuntimeHandle, lines = 50): Promise<string> {
      try {
        return await docker("logs", "--tail", String(lines), handle.id);
      } catch {
        return "";
      }
    },

    async isAlive(handle: RuntimeHandle): Promise<boolean> {
      try {
        const result = await docker(
          "inspect",
          "--format",
          "{{.State.Running}}",
          handle.id,
        );
        return result === "true";
      } catch {
        return false;
      }
    },

    async getMetrics(handle: RuntimeHandle): Promise<RuntimeMetrics> {
      const createdAt = (handle.data.createdAt as number) ?? Date.now();
      return {
        uptimeMs: Date.now() - createdAt,
      };
    },

    async getAttachInfo(handle: RuntimeHandle): Promise<AttachInfo> {
      return {
        type: "docker",
        target: handle.id,
        command: `docker exec -it ${handle.id} /bin/sh`,
      };
    },
  };
}

export default { manifest, create } satisfies PluginModule<Runtime>;
