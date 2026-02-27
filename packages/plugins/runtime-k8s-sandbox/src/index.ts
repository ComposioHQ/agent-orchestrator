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
  name: "k8s-sandbox",
  slot: "runtime" as const,
  description: "Runtime plugin: Kubernetes CRD sandboxes (warm pools, gVisor/Kata)",
  version: "0.1.0",
};

const CMD_TIMEOUT_MS = 30_000;

/** Only allow safe characters in session IDs for K8s resource names */
const SAFE_NAME = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

function sanitizeName(sessionId: string): string {
  // K8s names must be lowercase, alphanumeric + hyphens, max 63 chars
  const name = `ao-${sessionId}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 63);
  if (!SAFE_NAME.test(name)) {
    throw new Error(
      `Cannot create valid K8s name from session ID "${sessionId}"`,
    );
  }
  return name;
}

/** Run kubectl and return stdout */
async function kubectl(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("kubectl", args, {
    timeout: CMD_TIMEOUT_MS,
  });
  return stdout.trimEnd();
}

export function create(): Runtime {
  return {
    name: "k8s-sandbox",

    async create(config: RuntimeCreateConfig): Promise<RuntimeHandle> {
      const name = sanitizeName(config.sessionId);
      const namespace = process.env["K8S_SANDBOX_NAMESPACE"] ?? "ao-sandboxes";
      const image = process.env["K8S_SANDBOX_IMAGE"] ?? "ubuntu:22.04";
      const runtimeClass = process.env["K8S_SANDBOX_RUNTIME_CLASS"]; // e.g., "gvisor" or "kata"
      const useWarmPool = process.env["K8S_SANDBOX_WARM_POOL"] === "true";

      if (useWarmPool) {
        // Claim a pre-warmed sandbox from the warm pool via CRD
        const claimSpec = JSON.stringify({
          apiVersion: "sandbox.ao.dev/v1",
          kind: "SandboxClaim",
          metadata: {
            name,
            namespace,
            labels: {
              "ao-session": config.sessionId,
              "managed-by": "agent-orchestrator",
            },
          },
          spec: {
            image,
            command: ["sh", "-c", config.launchCommand],
            workdir: config.workspacePath,
            env: Object.entries({
              ...config.environment,
              AO_SESSION_ID: config.sessionId,
              AO_WORKSPACE: config.workspacePath,
            }).map(([key, value]) => ({ name: key, value })),
            ...(runtimeClass ? { runtimeClassName: runtimeClass } : {}),
          },
        });

        const { writeFileSync, unlinkSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const { randomUUID } = await import("node:crypto");
        const tmpPath = join(tmpdir(), `ao-k8s-${randomUUID()}.json`);
        writeFileSync(tmpPath, claimSpec, { encoding: "utf-8", mode: 0o600 });
        try {
          await kubectl("apply", "-f", tmpPath, "--namespace", namespace);
        } finally {
          try {
            unlinkSync(tmpPath);
          } catch {
            /* ignore cleanup errors */
          }
        }
      } else {
        // Create a regular pod
        const podSpec: Record<string, unknown> = {
          apiVersion: "v1",
          kind: "Pod",
          metadata: {
            name,
            namespace,
            labels: {
              "ao-session": config.sessionId,
              "managed-by": "agent-orchestrator",
            },
          },
          spec: {
            ...(runtimeClass ? { runtimeClassName: runtimeClass } : {}),
            restartPolicy: "Never",
            containers: [
              {
                name: "sandbox",
                image,
                command: ["sh", "-c", config.launchCommand],
                workingDir: config.workspacePath,
                env: Object.entries({
                  ...config.environment,
                  AO_SESSION_ID: config.sessionId,
                  AO_WORKSPACE: config.workspacePath,
                }).map(([key, value]) => ({ name: key, value })),
                resources: {
                  requests: { cpu: "500m", memory: "512Mi" },
                  limits: { cpu: "2", memory: "2Gi" },
                },
              },
            ],
          },
        };

        const { writeFileSync, unlinkSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const { randomUUID } = await import("node:crypto");
        const tmpPath = join(tmpdir(), `ao-k8s-${randomUUID()}.json`);
        writeFileSync(tmpPath, JSON.stringify(podSpec), {
          encoding: "utf-8",
          mode: 0o600,
        });
        try {
          await kubectl("apply", "-f", tmpPath, "--namespace", namespace);
        } finally {
          try {
            unlinkSync(tmpPath);
          } catch {
            /* ignore cleanup errors */
          }
        }
      }

      // Wait for the pod to be running
      await kubectl(
        "wait",
        "--for=condition=Ready",
        `pod/${name}`,
        "--namespace", namespace,
        "--timeout=120s",
      );

      return {
        id: name,
        runtimeName: "k8s-sandbox",
        data: {
          namespace,
          createdAt: Date.now(),
          workspacePath: config.workspacePath,
          useWarmPool,
        },
      };
    },

    async destroy(handle: RuntimeHandle): Promise<void> {
      const namespace = (handle.data["namespace"] as string) ?? "ao-sandboxes";
      const useWarmPool = handle.data["useWarmPool"] as boolean;

      try {
        if (useWarmPool) {
          await kubectl(
            "delete", "sandboxclaim", handle.id,
            "--namespace", namespace,
            "--ignore-not-found",
          );
        } else {
          await kubectl(
            "delete", "pod", handle.id,
            "--namespace", namespace,
            "--grace-period=10",
            "--ignore-not-found",
          );
        }
      } catch {
        // Resource may already be deleted
      }
    },

    async sendMessage(handle: RuntimeHandle, message: string): Promise<void> {
      const namespace = (handle.data["namespace"] as string) ?? "ao-sandboxes";

      await kubectl(
        "exec", handle.id,
        "--namespace", namespace,
        "-c", "sandbox",
        "--",
        "sh", "-c", `printf '%s\\n' ${shellEscape(message)} >> /tmp/ao-input`,
      );
    },

    async getOutput(handle: RuntimeHandle, lines = 50): Promise<string> {
      const namespace = (handle.data["namespace"] as string) ?? "ao-sandboxes";

      try {
        return await kubectl(
          "exec", handle.id,
          "--namespace", namespace,
          "-c", "sandbox",
          "--",
          "tail", "-n", String(lines), "/tmp/ao-output",
        );
      } catch {
        // Fallback to pod logs
        try {
          return await kubectl(
            "logs", handle.id,
            "--namespace", namespace,
            "-c", "sandbox",
            `--tail=${lines}`,
          );
        } catch {
          return "";
        }
      }
    },

    async isAlive(handle: RuntimeHandle): Promise<boolean> {
      const namespace = (handle.data["namespace"] as string) ?? "ao-sandboxes";

      try {
        const status = await kubectl(
          "get", "pod", handle.id,
          "--namespace", namespace,
          "-o", "jsonpath={.status.phase}",
        );
        return status === "Running";
      } catch {
        return false;
      }
    },

    async getMetrics(handle: RuntimeHandle): Promise<RuntimeMetrics> {
      const createdAt = (handle.data["createdAt"] as number) ?? Date.now();
      const namespace = (handle.data["namespace"] as string) ?? "ao-sandboxes";

      const metrics: RuntimeMetrics = {
        uptimeMs: Date.now() - createdAt,
      };

      try {
        const output = await kubectl(
          "top", "pod", handle.id,
          "--namespace", namespace,
          "--no-headers",
        );
        // Output format: NAME CPU(cores) MEMORY(bytes)
        const parts = output.trim().split(/\s+/);
        if (parts.length >= 3) {
          const memStr = parts[2];
          if (memStr && memStr.endsWith("Mi")) {
            metrics.memoryMb = parseInt(memStr, 10);
          }
          const cpuStr = parts[1];
          if (cpuStr && cpuStr.endsWith("m")) {
            metrics.cpuPercent = parseInt(cpuStr, 10) / 10;
          }
        }
      } catch {
        // Metrics server may not be available
      }

      return metrics;
    },

    async getAttachInfo(handle: RuntimeHandle): Promise<AttachInfo> {
      const namespace = (handle.data["namespace"] as string) ?? "ao-sandboxes";
      return {
        type: "k8s",
        target: handle.id,
        command: `kubectl exec -it ${handle.id} --namespace ${namespace} -c sandbox -- /bin/bash`,
      };
    },
  };
}

export default { manifest, create } satisfies PluginModule<Runtime>;
