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
  name: "lxc",
  slot: "runtime" as const,
  description: "Runtime plugin: LXC/LXD/Incus system containers",
  version: "0.1.0",
};

const CMD_TIMEOUT_MS = 30_000;

/** Detect whether to use the `lxc` or `incus` CLI */
function getLxcBinary(): string {
  return process.env["LXC_BINARY"] ?? "lxc";
}

/** Run an lxc/incus command and return stdout */
async function lxc(...args: string[]): Promise<string> {
  const binary = getLxcBinary();
  const { stdout } = await execFileAsync(binary, args, {
    timeout: CMD_TIMEOUT_MS,
  });
  return stdout.trimEnd();
}

/** Only allow safe characters in container names */
const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9-]*$/;

function sanitizeName(sessionId: string): string {
  const name = `ao-${sessionId}`;
  if (!SAFE_NAME.test(name)) {
    throw new Error(
      `Cannot create valid LXC container name from session ID "${sessionId}"`,
    );
  }
  return name;
}

export function create(): Runtime {
  return {
    name: "lxc",

    async create(config: RuntimeCreateConfig): Promise<RuntimeHandle> {
      const containerName = sanitizeName(config.sessionId);
      const image = process.env["LXC_IMAGE"] ?? "ubuntu:22.04";
      const remote = process.env["LXC_REMOTE"]; // e.g., "myserver:"

      const imageRef = remote ? `${remote}${image}` : image;

      // Launch the container
      await lxc("launch", imageRef, containerName);

      // Wait for the container to get a network address (indicates readiness)
      // Retry a few times since networking may take a moment
      let ready = false;
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          const info = await lxc("info", containerName);
          if (info.includes("eth0") || info.includes("Status: RUNNING")) {
            ready = true;
            break;
          }
        } catch {
          // Container may not be ready yet
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      if (!ready) {
        // Clean up on failure
        try {
          await lxc("delete", containerName, "--force");
        } catch {
          /* best effort */
        }
        throw new Error(
          `LXC container "${containerName}" did not reach running state`,
        );
      }

      // Set environment variables in the container
      for (const [key, value] of Object.entries(config.environment ?? {})) {
        await lxc(
          "config", "set", containerName,
          `environment.${key}`, value,
        );
      }
      await lxc(
        "config", "set", containerName,
        "environment.AO_SESSION_ID", config.sessionId,
      );
      await lxc(
        "config", "set", containerName,
        "environment.AO_WORKSPACE", config.workspacePath,
      );

      // Push workspace directory (create it) and execute the launch command
      try {
        await lxc("exec", containerName, "--", "mkdir", "-p", config.workspacePath);
      } catch {
        // Directory may already exist
      }

      // Run the launch command in background
      await lxc(
        "exec", containerName, "--",
        "sh", "-c",
        `cd ${shellEscape(config.workspacePath)} && nohup sh -c ${shellEscape(config.launchCommand)} > /tmp/ao-output 2>&1 &`,
      );

      return {
        id: containerName,
        runtimeName: "lxc",
        data: {
          createdAt: Date.now(),
          workspacePath: config.workspacePath,
        },
      };
    },

    async destroy(handle: RuntimeHandle): Promise<void> {
      try {
        await lxc("delete", handle.id, "--force");
      } catch {
        // Container may already be deleted
      }
    },

    async sendMessage(handle: RuntimeHandle, message: string): Promise<void> {
      await lxc(
        "exec", handle.id, "--",
        "sh", "-c", `printf '%s\\n' ${shellEscape(message)} >> /tmp/ao-input`,
      );
    },

    async getOutput(handle: RuntimeHandle, lines = 50): Promise<string> {
      try {
        return await lxc(
          "exec", handle.id, "--",
          "tail", "-n", String(lines), "/tmp/ao-output",
        );
      } catch {
        return "";
      }
    },

    async isAlive(handle: RuntimeHandle): Promise<boolean> {
      try {
        const output = await lxc("list", handle.id, "--format", "csv", "-c", "s");
        return output.trim() === "RUNNING";
      } catch {
        return false;
      }
    },

    async getMetrics(handle: RuntimeHandle): Promise<RuntimeMetrics> {
      const createdAt = (handle.data["createdAt"] as number) ?? Date.now();

      const metrics: RuntimeMetrics = {
        uptimeMs: Date.now() - createdAt,
      };

      try {
        const info = await lxc("info", handle.id);
        // Parse memory from lxc info output:
        // Memory (current): 123.45MiB
        const memMatch = /Memory \(current\):\s*([\d.]+)\s*MiB/i.exec(info);
        if (memMatch?.[1]) {
          metrics.memoryMb = parseFloat(memMatch[1]);
        }
        // Parse CPU usage:
        // CPU usage (in seconds): 12.34
        const cpuMatch = /CPU usage \(in seconds\):\s*([\d.]+)/i.exec(info);
        if (cpuMatch?.[1]) {
          const cpuSeconds = parseFloat(cpuMatch[1]);
          const uptimeSeconds = metrics.uptimeMs / 1000;
          if (uptimeSeconds > 0) {
            metrics.cpuPercent = (cpuSeconds / uptimeSeconds) * 100;
          }
        }
      } catch {
        // Metrics may not be available
      }

      return metrics;
    },

    async getAttachInfo(handle: RuntimeHandle): Promise<AttachInfo> {
      const binary = getLxcBinary();
      return {
        type: "lxc",
        target: handle.id,
        command: `${binary} exec ${handle.id} -- /bin/bash`,
      };
    },
  };
}

export default { manifest, create } satisfies PluginModule<Runtime>;
