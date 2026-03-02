import type {
  PluginModule,
  Runtime,
  RuntimeCreateConfig,
  RuntimeHandle,
  RuntimeMetrics,
  AttachInfo,
} from "@composio/ao-core";

export const manifest = {
  name: "fly",
  slot: "runtime" as const,
  description: "Runtime plugin: Fly.io Machines (Firecracker VMs)",
  version: "0.1.0",
};

const BASE_URL = "https://api.machines.dev/v1";
const DEFAULT_TIMEOUT_MS = 30_000;

function getToken(): string {
  const token = process.env["FLY_API_TOKEN"];
  if (!token) {
    throw new Error("FLY_API_TOKEN environment variable is required");
  }
  return token;
}

function getAppName(): string {
  const app = process.env["FLY_APP_NAME"];
  if (!app) {
    throw new Error("FLY_APP_NAME environment variable is required");
  }
  return app;
}

async function flyFetch(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
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
        `Fly API error ${response.status} ${response.statusText}: ${body}`,
      );
    }

    return response;
  } finally {
    clearTimeout(timeout);
  }
}

export function create(): Runtime {
  return {
    name: "fly",

    async create(config: RuntimeCreateConfig): Promise<RuntimeHandle> {
      const app = getAppName();
      const image = process.env["FLY_IMAGE"] ?? "ubuntu:22.04";

      // Create a Fly Machine with the launch command
      const machineConfig = {
        name: `ao-${config.sessionId}`,
        config: {
          image,
          env: {
            ...config.environment,
            AO_SESSION_ID: config.sessionId,
            AO_WORKSPACE: config.workspacePath,
          },
          init: {
            cmd: ["sh", "-c", config.launchCommand],
          },
          guest: {
            cpu_kind: "shared",
            cpus: 1,
            memory_mb: 1024,
          },
          auto_destroy: false,
        },
      };

      const response = await flyFetch(`/apps/${app}/machines`, {
        method: "POST",
        body: JSON.stringify(machineConfig),
      });

      let machine: { id: string; state: string };
      try {
        machine = (await response.json()) as { id: string; state: string };
      } catch {
        throw new Error("Failed to parse Fly Machine creation response");
      }

      if (!machine.id) {
        throw new Error("Fly Machine creation did not return a machine ID");
      }

      // Wait for machine to reach started state
      await flyFetch(
        `/apps/${app}/machines/${machine.id}/wait?state=started&timeout=30`,
      );

      return {
        id: machine.id,
        runtimeName: "fly",
        data: {
          app,
          createdAt: Date.now(),
          workspacePath: config.workspacePath,
        },
      };
    },

    async destroy(handle: RuntimeHandle): Promise<void> {
      const app = handle.data["app"] as string;
      if (!app) return;

      try {
        // Stop the machine first
        await flyFetch(`/apps/${app}/machines/${handle.id}/stop`, {
          method: "POST",
          body: JSON.stringify({ signal: "SIGTERM", timeout: "5s" }),
        });

        // Wait for stopped state
        await flyFetch(
          `/apps/${app}/machines/${handle.id}/wait?state=stopped&timeout=10`,
        ).catch(() => {
          // Machine may already be stopped
        });

        // Destroy the machine
        await flyFetch(`/apps/${app}/machines/${handle.id}?force=true`, {
          method: "DELETE",
        });
      } catch {
        // Machine may already be destroyed
      }
    },

    async sendMessage(handle: RuntimeHandle, message: string): Promise<void> {
      const app = handle.data["app"] as string;
      if (!app) {
        throw new Error(`No app found for machine ${handle.id}`);
      }

      // Execute command inside the running machine via exec endpoint
      const response = await flyFetch(
        `/apps/${app}/machines/${handle.id}/exec`,
        {
          method: "POST",
          body: JSON.stringify({
            cmd: ["sh", "-c", `echo ${JSON.stringify(message)} >> /tmp/ao-input`],
            timeout: 10,
          }),
        },
      );

      const result = (await response.json()) as { exit_code?: number };
      if (result.exit_code !== undefined && result.exit_code !== 0) {
        throw new Error(
          `Failed to send message to machine ${handle.id}: exit code ${result.exit_code}`,
        );
      }
    },

    async getOutput(handle: RuntimeHandle, lines = 50): Promise<string> {
      const app = handle.data["app"] as string;
      if (!app) return "";

      try {
        const response = await flyFetch(
          `/apps/${app}/machines/${handle.id}/exec`,
          {
            method: "POST",
            body: JSON.stringify({
              cmd: ["tail", "-n", String(lines), "/tmp/ao-output"],
              timeout: 10,
            }),
          },
        );

        const result = (await response.json()) as {
          stdout?: string;
          stderr?: string;
        };
        return result.stdout ?? result.stderr ?? "";
      } catch {
        return "";
      }
    },

    async isAlive(handle: RuntimeHandle): Promise<boolean> {
      const app = handle.data["app"] as string;
      if (!app) return false;

      try {
        const response = await flyFetch(
          `/apps/${app}/machines/${handle.id}`,
        );

        const machine = (await response.json()) as { state: string };
        return machine.state === "started" || machine.state === "starting";
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
      const app = handle.data["app"] as string;
      return {
        type: "ssh",
        target: handle.id,
        command: `fly ssh console -a ${app} -s ${handle.id}`,
      };
    },
  };
}

export default { manifest, create } satisfies PluginModule<Runtime>;
