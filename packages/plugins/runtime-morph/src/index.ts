import {
  shellEscape,
  type PluginModule,
  type Runtime,
  type RuntimeCreateConfig,
  type RuntimeHandle,
  type RuntimeMetrics,
  type AttachInfo,
} from "@composio/ao-core";

export const manifest = {
  name: "morph",
  slot: "runtime" as const,
  description: "Runtime plugin: Morph snapshot/branch sandboxes",
  version: "0.1.0",
};

const DEFAULT_TIMEOUT_MS = 30_000;

function getApiKey(): string {
  const key = process.env["MORPH_API_KEY"];
  if (!key) {
    throw new Error("MORPH_API_KEY environment variable is required");
  }
  return key;
}

function getBaseUrl(): string {
  return process.env["MORPH_API_URL"] ?? "https://api.morph.so/v1";
}

async function morphFetch(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const apiKey = getApiKey();
  const baseUrl = getBaseUrl();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl}${path}`, {
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
        `Morph API error ${response.status} ${response.statusText}: ${body}`,
      );
    }

    return response;
  } finally {
    clearTimeout(timeout);
  }
}

export function create(): Runtime {
  return {
    name: "morph",

    async create(config: RuntimeCreateConfig): Promise<RuntimeHandle> {
      const snapshotId = process.env["MORPH_SNAPSHOT_ID"];

      // Create a sandbox from snapshot or base image
      const createBody: Record<string, unknown> = {
        name: `ao-${config.sessionId}`,
        environment: {
          ...config.environment,
          AO_SESSION_ID: config.sessionId,
          AO_WORKSPACE: config.workspacePath,
        },
      };

      if (snapshotId) {
        createBody["snapshot_id"] = snapshotId;
      }

      const response = await morphFetch("/sandboxes", {
        method: "POST",
        body: JSON.stringify(createBody),
      });

      let sandbox: { id: string; status: string };
      try {
        sandbox = (await response.json()) as { id: string; status: string };
      } catch {
        throw new Error("Failed to parse Morph sandbox creation response");
      }

      if (!sandbox.id) {
        throw new Error("Morph sandbox creation did not return a sandbox ID");
      }

      // Execute the launch command inside the sandbox
      await morphFetch(`/sandboxes/${sandbox.id}/exec`, {
        method: "POST",
        body: JSON.stringify({
          command: config.launchCommand,
          workdir: config.workspacePath,
          background: true,
        }),
      });

      return {
        id: sandbox.id,
        runtimeName: "morph",
        data: {
          createdAt: Date.now(),
          workspacePath: config.workspacePath,
        },
      };
    },

    async destroy(handle: RuntimeHandle): Promise<void> {
      try {
        await morphFetch(`/sandboxes/${handle.id}`, {
          method: "DELETE",
        });
      } catch {
        // Sandbox may already be destroyed
      }
    },

    async sendMessage(handle: RuntimeHandle, message: string): Promise<void> {
      await morphFetch(`/sandboxes/${handle.id}/exec`, {
        method: "POST",
        body: JSON.stringify({
          command: `printf '%s\\n' ${shellEscape(message)} >> /tmp/ao-input`,
          workdir: "/",
        }),
      });
    },

    async getOutput(handle: RuntimeHandle, lines = 50): Promise<string> {
      try {
        const response = await morphFetch(`/sandboxes/${handle.id}/exec`, {
          method: "POST",
          body: JSON.stringify({
            command: `tail -n ${lines} /tmp/ao-output 2>/dev/null || echo ""`,
            workdir: "/",
          }),
        });

        const result = (await response.json()) as { output?: string };
        return result.output ?? "";
      } catch {
        return "";
      }
    },

    async isAlive(handle: RuntimeHandle): Promise<boolean> {
      try {
        const response = await morphFetch(`/sandboxes/${handle.id}`);
        const sandbox = (await response.json()) as { status: string };
        return sandbox.status === "running";
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
        command: `morph connect ${handle.id}`,
      };
    },
  };
}

export default { manifest, create } satisfies PluginModule<Runtime>;
