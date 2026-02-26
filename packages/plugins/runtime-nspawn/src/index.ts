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
  name: "nspawn",
  slot: "runtime" as const,
  description: "Runtime plugin: systemd-nspawn (lightweight Linux containers)",
  version: "0.1.0",
};

const CMD_TIMEOUT_MS = 30_000;

/** Only allow safe characters in machine names */
const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

function sanitizeName(sessionId: string): string {
  const name = `ao-${sessionId}`;
  if (!SAFE_NAME.test(name)) {
    throw new Error(
      `Cannot create valid nspawn machine name from session ID "${sessionId}"`,
    );
  }
  return name;
}

/** Run machinectl command and return stdout */
async function machinectl(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("machinectl", args, {
    timeout: CMD_TIMEOUT_MS,
  });
  return stdout.trimEnd();
}

/** Run systemd-nspawn or machinectl shell commands */
async function nspawnExec(
  machineName: string,
  command: string,
): Promise<string> {
  const { stdout } = await execFileAsync(
    "machinectl",
    ["shell", machineName, "/bin/sh", "-c", command],
    { timeout: CMD_TIMEOUT_MS },
  );
  return stdout.trimEnd();
}

export function create(): Runtime {
  return {
    name: "nspawn",

    async create(config: RuntimeCreateConfig): Promise<RuntimeHandle> {
      const machineName = sanitizeName(config.sessionId);
      const machineDir =
        process.env["NSPAWN_MACHINES_DIR"] ?? "/var/lib/machines";
      const baseImage = process.env["NSPAWN_BASE_IMAGE"];
      const machinePath = `${machineDir}/${machineName}`;

      if (baseImage) {
        // Clone from a base image using machinectl
        await machinectl("clone", baseImage, machineName);
      } else {
        // Create a minimal directory tree for the container
        // Requires debootstrap or a pre-existing base
        await execFileAsync(
          "mkdir",
          ["-p", `${machinePath}/tmp`, `${machinePath}/root`],
          { timeout: CMD_TIMEOUT_MS },
        );
      }

      // Build environment arguments for systemd-nspawn
      const envArgs: string[] = [];
      for (const [key, value] of Object.entries(config.environment ?? {})) {
        envArgs.push(`--setenv=${key}=${value}`);
      }
      envArgs.push(`--setenv=AO_SESSION_ID=${config.sessionId}`);
      envArgs.push(`--setenv=AO_WORKSPACE=${config.workspacePath}`);

      // Start the container in the background using machinectl/systemd-nspawn
      // Use systemd-nspawn with --boot for systemd-managed lifecycle,
      // or without for direct command execution
      const nspawnArgs = [
        "--machine", machineName,
        "--directory", machinePath,
        "--boot",
        "--notify-ready=yes",
        ...envArgs,
        `--bind=${config.workspacePath}`,
      ];

      // Start the nspawn container via systemd-run for proper management
      await execFileAsync(
        "systemd-run",
        [
          "--unit", `ao-nspawn-${machineName}`,
          "--service-type=notify",
          "systemd-nspawn",
          ...nspawnArgs,
        ],
        { timeout: CMD_TIMEOUT_MS },
      );

      // Wait for the machine to be ready
      let ready = false;
      for (let attempt = 0; attempt < 15; attempt++) {
        try {
          const status = await machinectl("status", machineName);
          if (status.includes("State: running")) {
            ready = true;
            break;
          }
        } catch {
          // Machine may not be ready yet
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      if (!ready) {
        // Clean up on failure
        try {
          await machinectl("terminate", machineName);
        } catch {
          /* best effort */
        }
        try {
          await machinectl("remove", machineName);
        } catch {
          /* best effort */
        }
        throw new Error(
          `nspawn machine "${machineName}" did not reach running state`,
        );
      }

      // Execute the launch command inside the container
      await nspawnExec(
        machineName,
        `cd ${JSON.stringify(config.workspacePath)} && nohup sh -c ${JSON.stringify(config.launchCommand)} > /tmp/ao-output 2>&1 &`,
      );

      return {
        id: machineName,
        runtimeName: "nspawn",
        data: {
          machinePath,
          createdAt: Date.now(),
          workspacePath: config.workspacePath,
        },
      };
    },

    async destroy(handle: RuntimeHandle): Promise<void> {
      try {
        // Poweroff the machine gracefully
        await machinectl("poweroff", handle.id);
        // Wait for it to stop
        for (let attempt = 0; attempt < 10; attempt++) {
          try {
            await machinectl("status", handle.id);
            // Still running, wait
            await new Promise((resolve) => setTimeout(resolve, 500));
          } catch {
            // Machine is gone
            break;
          }
        }
      } catch {
        // Machine may already be stopped
        try {
          await machinectl("terminate", handle.id);
        } catch {
          // Already terminated
        }
      }

      // Remove the machine image
      try {
        await machinectl("remove", handle.id);
      } catch {
        // Already removed
      }
    },

    async sendMessage(handle: RuntimeHandle, message: string): Promise<void> {
      await nspawnExec(
        handle.id,
        `echo ${JSON.stringify(message)} >> /tmp/ao-input`,
      );
    },

    async getOutput(handle: RuntimeHandle, lines = 50): Promise<string> {
      try {
        return await nspawnExec(
          handle.id,
          `tail -n ${lines} /tmp/ao-output 2>/dev/null || echo ""`,
        );
      } catch {
        return "";
      }
    },

    async isAlive(handle: RuntimeHandle): Promise<boolean> {
      try {
        const output = await machinectl("show", handle.id, "--property=State");
        return output.includes("State=running");
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
        const status = await machinectl("status", handle.id);
        // Parse memory from machinectl status output
        const memMatch = /Memory:\s*([\d.]+)\s*M/i.exec(status);
        if (memMatch?.[1]) {
          metrics.memoryMb = parseFloat(memMatch[1]);
        }
      } catch {
        // Metrics may not be available
      }

      return metrics;
    },

    async getAttachInfo(handle: RuntimeHandle): Promise<AttachInfo> {
      return {
        type: "docker",
        target: handle.id,
        command: `machinectl shell ${handle.id}`,
      };
    },
  };
}

export default { manifest, create } satisfies PluginModule<Runtime>;
