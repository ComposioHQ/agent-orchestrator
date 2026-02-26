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
  name: "podman",
  slot: "runtime" as const,
  description: "Runtime plugin: Podman (daemonless, rootless containers)",
  version: "0.1.0",
};

const CMD_TIMEOUT_MS = 30_000;

/** Run a podman command and return stdout */
async function podman(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("podman", args, {
    timeout: CMD_TIMEOUT_MS,
  });
  return stdout.trimEnd();
}

export function create(): Runtime {
  return {
    name: "podman",

    async create(config: RuntimeCreateConfig): Promise<RuntimeHandle> {
      const image = process.env["PODMAN_IMAGE"] ?? "ubuntu:22.04";
      const containerName = `ao-${config.sessionId}`;

      // Build environment flags
      const envArgs: string[] = [];
      for (const [key, value] of Object.entries(config.environment ?? {})) {
        envArgs.push("-e", `${key}=${value}`);
      }
      envArgs.push("-e", `AO_SESSION_ID=${config.sessionId}`);
      envArgs.push("-e", `AO_WORKSPACE=${config.workspacePath}`);

      // Create the container
      const containerId = await podman(
        "create",
        "--name", containerName,
        "--workdir", config.workspacePath,
        "-v", `${config.workspacePath}:${config.workspacePath}`,
        ...envArgs,
        image,
        "sh", "-c", config.launchCommand,
      );

      // Start the container
      await podman("start", containerName);

      return {
        id: containerId.trim(),
        runtimeName: "podman",
        data: {
          containerName,
          createdAt: Date.now(),
          workspacePath: config.workspacePath,
        },
      };
    },

    async destroy(handle: RuntimeHandle): Promise<void> {
      const containerName = (handle.data["containerName"] as string) ?? handle.id;

      try {
        // Stop with a grace period
        await podman("stop", "-t", "10", containerName);
      } catch {
        // Container may already be stopped
      }

      try {
        // Remove the container
        await podman("rm", "-f", containerName);
      } catch {
        // Container may already be removed
      }
    },

    async sendMessage(handle: RuntimeHandle, message: string): Promise<void> {
      const containerName = (handle.data["containerName"] as string) ?? handle.id;

      // Use shellEscape (POSIX single-quote wrapping) instead of JSON.stringify
      // to safely pass user-controlled message to sh -c
      await podman(
        "exec", containerName,
        "sh", "-c", `printf '%s\\n' ${shellEscape(message)} >> /tmp/ao-input`,
      );
    },

    async getOutput(handle: RuntimeHandle, lines = 50): Promise<string> {
      const containerName = (handle.data["containerName"] as string) ?? handle.id;

      try {
        return await podman(
          "exec", containerName,
          "tail", "-n", String(lines), "/tmp/ao-output",
        );
      } catch {
        // Fallback to container logs
        try {
          return await podman(
            "logs", "--tail", String(lines), containerName,
          );
        } catch {
          return "";
        }
      }
    },

    async isAlive(handle: RuntimeHandle): Promise<boolean> {
      const containerName = (handle.data["containerName"] as string) ?? handle.id;

      try {
        const status = await podman(
          "inspect", "--format", "{{.State.Status}}", containerName,
        );
        return status.trim() === "running";
      } catch {
        return false;
      }
    },

    async getMetrics(handle: RuntimeHandle): Promise<RuntimeMetrics> {
      const containerName = (handle.data["containerName"] as string) ?? handle.id;
      const createdAt = (handle.data["createdAt"] as number) ?? Date.now();

      const metrics: RuntimeMetrics = {
        uptimeMs: Date.now() - createdAt,
      };

      try {
        const statsOutput = await podman(
          "stats", "--no-stream", "--format",
          "{{.MemUsage}}||{{.CPUPerc}}",
          containerName,
        );
        const parts = statsOutput.trim().split("||");
        if (parts.length >= 2) {
          // Parse memory: "123.4MiB / 1.0GiB"
          const memPart = parts[0];
          if (memPart) {
            const memMatch = /^([\d.]+)\s*MiB/i.exec(memPart.trim());
            if (memMatch?.[1]) {
              metrics.memoryMb = parseFloat(memMatch[1]);
            }
          }
          // Parse CPU: "12.34%"
          const cpuPart = parts[1];
          if (cpuPart) {
            const cpuMatch = /^([\d.]+)%/.exec(cpuPart.trim());
            if (cpuMatch?.[1]) {
              metrics.cpuPercent = parseFloat(cpuMatch[1]);
            }
          }
        }
      } catch {
        // Stats may not be available
      }

      return metrics;
    },

    async getAttachInfo(handle: RuntimeHandle): Promise<AttachInfo> {
      const containerName = (handle.data["containerName"] as string) ?? handle.id;
      return {
        type: "docker",
        target: containerName,
        command: `podman exec -it ${containerName} /bin/bash`,
      };
    },
  };
}

export default { manifest, create } satisfies PluginModule<Runtime>;
