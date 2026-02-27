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
  name: "hetzner",
  slot: "runtime" as const,
  description: "Runtime plugin: Hetzner Cloud VMs",
  version: "0.1.0",
};

const BASE_URL = "https://api.hetzner.cloud/v1";
const DEFAULT_TIMEOUT_MS = 30_000;

function getToken(): string {
  const token = process.env["HETZNER_API_TOKEN"];
  if (!token) {
    throw new Error("HETZNER_API_TOKEN environment variable is required");
  }
  return token;
}

async function hetznerFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = getToken();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Hetzner API error ${response.status} ${response.statusText}: ${body}`,
      );
    }

    let parsed: T;
    try {
      parsed = (await response.json()) as T;
    } catch {
      throw new Error("Failed to parse Hetzner API response");
    }

    return parsed;
  } finally {
    clearTimeout(timeout);
  }
}

/** Run an SSH command on a remote server */
async function sshExec(
  ipAddress: string,
  command: string,
): Promise<string> {
  const sshKey = process.env["HETZNER_SSH_KEY_PATH"] ?? "~/.ssh/id_rsa";

  const { stdout } = await execFileAsync(
    "ssh",
    [
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "ConnectTimeout=10",
      "-i", sshKey,
      `root@${ipAddress}`,
      command,
    ],
    { timeout: DEFAULT_TIMEOUT_MS },
  );

  return stdout.trimEnd();
}

export function create(): Runtime {
  return {
    name: "hetzner",

    async create(config: RuntimeCreateConfig): Promise<RuntimeHandle> {
      const serverType = process.env["HETZNER_SERVER_TYPE"] ?? "cx22";
      const image = process.env["HETZNER_IMAGE"] ?? "ubuntu-22.04";
      const location = process.env["HETZNER_LOCATION"] ?? "fsn1";
      const sshKeyName = process.env["HETZNER_SSH_KEY_NAME"];

      // Build cloud-init user data to set up environment and run launch command
      const envExports = Object.entries(config.environment)
        .map(([key, value]) => `export ${key}=${shellEscape(value)}`)
        .join("\n");

      const userData = [
        "#!/bin/bash",
        `export AO_SESSION_ID=${shellEscape(config.sessionId)}`,
        `export AO_WORKSPACE=${shellEscape(config.workspacePath)}`,
        envExports,
        `mkdir -p ${shellEscape(config.workspacePath)}`,
        `cd ${shellEscape(config.workspacePath)}`,
        `nohup sh -c ${shellEscape(config.launchCommand)} > /tmp/ao-output 2>&1 &`,
      ].join("\n");

      const createBody: Record<string, unknown> = {
        name: `ao-${config.sessionId}`,
        server_type: serverType,
        image,
        location,
        user_data: userData,
        labels: {
          "ao-session": config.sessionId,
          "managed-by": "agent-orchestrator",
        },
      };

      if (sshKeyName) {
        createBody["ssh_keys"] = [sshKeyName];
      }

      const result = await hetznerFetch<{
        server: { id: number; public_net: { ipv4: { ip: string } } };
      }>("/servers", {
        method: "POST",
        body: JSON.stringify(createBody),
      });

      const serverId = result.server.id;
      const ipAddress = result.server.public_net.ipv4.ip;

      if (!serverId) {
        throw new Error("Hetzner server creation did not return a server ID");
      }

      return {
        id: String(serverId),
        runtimeName: "hetzner",
        data: {
          ipAddress,
          createdAt: Date.now(),
          workspacePath: config.workspacePath,
        },
      };
    },

    async destroy(handle: RuntimeHandle): Promise<void> {
      try {
        await hetznerFetch<unknown>(`/servers/${handle.id}`, {
          method: "DELETE",
        });
      } catch {
        // Server may already be destroyed
      }
    },

    async sendMessage(handle: RuntimeHandle, message: string): Promise<void> {
      const ipAddress = handle.data["ipAddress"] as string;
      if (!ipAddress) {
        throw new Error(`No IP address found for server ${handle.id}`);
      }

      await sshExec(
        ipAddress,
        `printf '%s\\n' ${shellEscape(message)} >> /tmp/ao-input`,
      );
    },

    async getOutput(handle: RuntimeHandle, lines = 50): Promise<string> {
      const ipAddress = handle.data["ipAddress"] as string;
      if (!ipAddress) return "";

      try {
        return await sshExec(
          ipAddress,
          `tail -n ${lines} /tmp/ao-output 2>/dev/null || echo ""`,
        );
      } catch {
        return "";
      }
    },

    async isAlive(handle: RuntimeHandle): Promise<boolean> {
      try {
        const result = await hetznerFetch<{
          server: { status: string };
        }>(`/servers/${handle.id}`);
        return result.server.status === "running";
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
      const ipAddress = handle.data["ipAddress"] as string;
      return {
        type: "ssh",
        target: ipAddress ?? handle.id,
        command: ipAddress ? `ssh root@${ipAddress}` : undefined,
      };
    },
  };
}

export default { manifest, create } satisfies PluginModule<Runtime>;
