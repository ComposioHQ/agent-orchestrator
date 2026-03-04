import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  PluginModule,
  Runtime,
  RuntimeCreateConfig,
  RuntimeHandle,
  RuntimeMetrics,
  AttachInfo,
} from "@composio/ao-core";

const execFileAsync = promisify(execFile);

export const manifest = {
  name: "docker",
  slot: "runtime" as const,
  description: "Runtime plugin: Docker containers",
  version: "0.1.0",
};

const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

function containerName(sessionId: string): string {
  if (!SAFE_ID.test(sessionId)) {
    throw new Error(`Invalid session ID '${sessionId}' for docker runtime`);
  }
  return `ao-${sessionId}`;
}

async function docker(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

export function create(config?: Record<string, unknown>): Runtime {
  const image = (config?.image as string | undefined) ?? process.env["AO_DOCKER_IMAGE"] ?? "node:20-bullseye";
  const createdAt = new Map<string, number>();

  return {
    name: "docker",

    async create(runtimeConfig: RuntimeCreateConfig): Promise<RuntimeHandle> {
      const name = containerName(runtimeConfig.sessionId);
      const envArgs = Object.entries(runtimeConfig.environment ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);

      await docker([
        "run",
        "-d",
        "--rm",
        "--name",
        name,
        "-v",
        `${runtimeConfig.workspacePath}:/workspace`,
        "-w",
        "/workspace",
        ...envArgs,
        image,
        "sh",
        "-lc",
        runtimeConfig.launchCommand,
      ]);

      createdAt.set(name, Date.now());
      return { id: name, runtimeName: "docker", data: { image, createdAt: Date.now() } };
    },

    async destroy(handle: RuntimeHandle): Promise<void> {
      try {
        await docker(["rm", "-f", handle.id]);
      } catch {
        // Container may already be gone.
      }
      createdAt.delete(handle.id);
    },

    async sendMessage(handle: RuntimeHandle, message: string): Promise<void> {
      const trimmed = message.trim();
      if (!trimmed) return;
      await docker(["exec", handle.id, "sh", "-lc", trimmed]);
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
        const status = await docker(["inspect", "-f", "{{.State.Running}}", handle.id]);
        return status.trim() === "true";
      } catch {
        return false;
      }
    },

    async getMetrics(handle: RuntimeHandle): Promise<RuntimeMetrics> {
      const start = createdAt.get(handle.id) ?? Date.now();
      return { uptimeMs: Date.now() - start };
    },

    async getAttachInfo(handle: RuntimeHandle): Promise<AttachInfo> {
      return {
        type: "docker",
        target: handle.id,
        command: `docker exec -it ${handle.id} sh`,
      };
    },
  };
}

export default { manifest, create } satisfies PluginModule<Runtime>;
