import type {
  PluginModule,
  Runtime,
  RuntimeCreateConfig,
  RuntimeHandle,
  RuntimeMetrics,
  AttachInfo,
} from "@composio/ao-core";

export const manifest = {
  name: "opensandbox",
  slot: "runtime" as const,
  description: "Runtime plugin: OpenSandbox (Docker/K8s backends, CRIU pause/resume)",
  version: "0.1.0",
};

const DEFAULT_TIMEOUT_MS = 30_000;

function getApiKey(): string {
  const key = process.env["OPENSANDBOX_API_KEY"];
  if (!key) {
    throw new Error("OPENSANDBOX_API_KEY environment variable is required");
  }
  return key;
}

function getHost(): string {
  const host = process.env["OPENSANDBOX_HOST"];
  if (!host) {
    throw new Error("OPENSANDBOX_HOST environment variable is required");
  }
  // Strip trailing slash
  return host.replace(/\/+$/, "");
}

async function osFetch(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const apiKey = getApiKey();
  const host = getHost();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(`${host}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `OpenSandbox API error ${response.status} ${response.statusText}: ${body}`,
      );
    }

    return response;
  } finally {
    clearTimeout(timeout);
  }
}

export function create(): Runtime {
  return {
    name: "opensandbox",

    async create(config: RuntimeCreateConfig): Promise<RuntimeHandle> {
      const image = process.env["OPENSANDBOX_IMAGE"] ?? "ubuntu:22.04";

      // Lifecycle API: create sandbox
      const response = await osFetch("/v1/sandboxes", {
        method: "POST",
        body: JSON.stringify({
          name: `ao-${config.sessionId}`,
          image,
          environment: {
            ...config.environment,
            AO_SESSION_ID: config.sessionId,
            AO_WORKSPACE: config.workspacePath,
          },
          workdir: config.workspacePath,
        }),
      });

      let sandbox: { id: string; status: string };
      try {
        sandbox = (await response.json()) as { id: string; status: string };
      } catch {
        throw new Error("Failed to parse OpenSandbox creation response");
      }

      if (!sandbox.id) {
        throw new Error(
          "OpenSandbox creation did not return a sandbox ID",
        );
      }

      // Execution API: run the launch command in background
      await osFetch(`/v1/sandboxes/${sandbox.id}/commands/run`, {
        method: "POST",
        body: JSON.stringify({
          command: config.launchCommand,
          background: true,
        }),
      });

      return {
        id: sandbox.id,
        runtimeName: "opensandbox",
        data: {
          createdAt: Date.now(),
          workspacePath: config.workspacePath,
        },
      };
    },

    async destroy(handle: RuntimeHandle): Promise<void> {
      try {
        await osFetch(`/v1/sandboxes/${handle.id}`, {
          method: "DELETE",
        });
      } catch {
        // Sandbox may already be destroyed
      }
    },

    async sendMessage(handle: RuntimeHandle, message: string): Promise<void> {
      await osFetch(`/v1/sandboxes/${handle.id}/commands/run`, {
        method: "POST",
        body: JSON.stringify({
          command: `echo ${JSON.stringify(message)} >> /tmp/ao-input`,
        }),
      });
    },

    async getOutput(handle: RuntimeHandle, lines = 50): Promise<string> {
      try {
        const response = await osFetch(
          `/v1/sandboxes/${handle.id}/commands/run`,
          {
            method: "POST",
            body: JSON.stringify({
              command: `tail -n ${lines} /tmp/ao-output 2>/dev/null || echo ""`,
            }),
          },
        );

        const result = (await response.json()) as {
          stdout?: string;
          output?: string;
        };
        return result.stdout ?? result.output ?? "";
      } catch {
        return "";
      }
    },

    async isAlive(handle: RuntimeHandle): Promise<boolean> {
      try {
        const response = await osFetch(`/v1/sandboxes/${handle.id}`);
        const sandbox = (await response.json()) as { status: string };
        return sandbox.status === "running";
      } catch {
        return false;
      }
    },

    async getMetrics(handle: RuntimeHandle): Promise<RuntimeMetrics> {
      const createdAt = (handle.data["createdAt"] as number) ?? Date.now();

      try {
        const response = await osFetch(`/v1/sandboxes/${handle.id}/metrics`);
        const metrics = (await response.json()) as {
          memory_mb?: number;
          cpu_percent?: number;
        };

        return {
          uptimeMs: Date.now() - createdAt,
          memoryMb: metrics.memory_mb,
          cpuPercent: metrics.cpu_percent,
        };
      } catch {
        return {
          uptimeMs: Date.now() - createdAt,
        };
      }
    },

    async getAttachInfo(handle: RuntimeHandle): Promise<AttachInfo> {
      const host = getHost();
      return {
        type: "web",
        target: `${host}/v1/sandboxes/${handle.id}/terminal`,
        command: `opensandbox exec ${handle.id} -- /bin/bash`,
      };
    },
  };
}

export default { manifest, create } satisfies PluginModule<Runtime>;
