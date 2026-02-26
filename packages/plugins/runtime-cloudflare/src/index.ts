import type {
  PluginModule,
  Runtime,
  RuntimeCreateConfig,
  RuntimeHandle,
  RuntimeMetrics,
  AttachInfo,
} from "@composio/ao-core";

export const manifest = {
  name: "cloudflare",
  slot: "runtime" as const,
  description: "Runtime plugin: Cloudflare Workers / Containers",
  version: "0.1.0",
};

const BASE_URL = "https://api.cloudflare.com/client/v4";
const DEFAULT_TIMEOUT_MS = 30_000;

function getToken(): string {
  const token = process.env["CLOUDFLARE_API_TOKEN"];
  if (!token) {
    throw new Error("CLOUDFLARE_API_TOKEN environment variable is required");
  }
  return token;
}

function getAccountId(): string {
  const accountId = process.env["CLOUDFLARE_ACCOUNT_ID"];
  if (!accountId) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID environment variable is required");
  }
  return accountId;
}

interface CfApiResponse<T> {
  success: boolean;
  result: T;
  errors: Array<{ code: number; message: string }>;
  messages: string[];
}

async function cfFetch<T>(
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
        `Cloudflare API error ${response.status} ${response.statusText}: ${body}`,
      );
    }

    let parsed: CfApiResponse<T>;
    try {
      parsed = (await response.json()) as CfApiResponse<T>;
    } catch {
      throw new Error("Failed to parse Cloudflare API response");
    }

    if (!parsed.success) {
      const errMsgs = parsed.errors.map((e) => e.message).join(", ");
      throw new Error(`Cloudflare API error: ${errMsgs}`);
    }

    return parsed.result;
  } finally {
    clearTimeout(timeout);
  }
}

export function create(): Runtime {
  return {
    name: "cloudflare",

    async create(config: RuntimeCreateConfig): Promise<RuntimeHandle> {
      const accountId = getAccountId();
      const image = process.env["CLOUDFLARE_CONTAINER_IMAGE"] ?? "ubuntu:22.04";

      // Create a Cloudflare container
      const container = await cfFetch<{ id: string; status: string }>(
        `/accounts/${accountId}/containers`,
        {
          method: "POST",
          body: JSON.stringify({
            name: `ao-${config.sessionId}`,
            image,
            environment_variables: Object.entries({
              ...config.environment,
              AO_SESSION_ID: config.sessionId,
              AO_WORKSPACE: config.workspacePath,
            }).map(([key, value]) => ({ name: key, value })),
            command: ["sh", "-c", config.launchCommand],
            memory_mb: 1024,
          }),
        },
      );

      if (!container.id) {
        throw new Error(
          "Cloudflare container creation did not return a container ID",
        );
      }

      return {
        id: container.id,
        runtimeName: "cloudflare",
        data: {
          accountId,
          createdAt: Date.now(),
          workspacePath: config.workspacePath,
        },
      };
    },

    async destroy(handle: RuntimeHandle): Promise<void> {
      const accountId = handle.data["accountId"] as string;
      if (!accountId) return;

      try {
        await cfFetch<unknown>(
          `/accounts/${accountId}/containers/${handle.id}`,
          { method: "DELETE" },
        );
      } catch {
        // Container may already be destroyed
      }
    },

    async sendMessage(handle: RuntimeHandle, message: string): Promise<void> {
      const accountId = handle.data["accountId"] as string;
      if (!accountId) {
        throw new Error(`No account ID for container ${handle.id}`);
      }

      await cfFetch<unknown>(
        `/accounts/${accountId}/containers/${handle.id}/exec`,
        {
          method: "POST",
          body: JSON.stringify({
            command: [
              "sh",
              "-c",
              `echo ${JSON.stringify(message)} >> /tmp/ao-input`,
            ],
          }),
        },
      );
    },

    async getOutput(handle: RuntimeHandle, lines = 50): Promise<string> {
      const accountId = handle.data["accountId"] as string;
      if (!accountId) return "";

      try {
        const result = await cfFetch<{ stdout?: string; stderr?: string }>(
          `/accounts/${accountId}/containers/${handle.id}/exec`,
          {
            method: "POST",
            body: JSON.stringify({
              command: ["tail", "-n", String(lines), "/tmp/ao-output"],
            }),
          },
        );

        return result.stdout ?? result.stderr ?? "";
      } catch {
        return "";
      }
    },

    async isAlive(handle: RuntimeHandle): Promise<boolean> {
      const accountId = handle.data["accountId"] as string;
      if (!accountId) return false;

      try {
        const container = await cfFetch<{ status: string }>(
          `/accounts/${accountId}/containers/${handle.id}`,
        );
        return container.status === "running";
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
        type: "web",
        target: handle.id,
        command: `wrangler containers exec ${handle.id} -- /bin/sh`,
      };
    },
  };
}

export default { manifest, create } satisfies PluginModule<Runtime>;
