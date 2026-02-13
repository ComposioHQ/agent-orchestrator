import { spawn, type ChildProcess } from "node:child_process";
import type {
  PluginModule,
  Runtime,
  RuntimeCreateConfig,
  RuntimeHandle,
  RuntimeMetrics,
  AttachInfo,
} from "@agent-orchestrator/core";

export const manifest = {
  name: "process",
  slot: "runtime" as const,
  description: "Runtime plugin: child processes",
  version: "0.1.0",
};

/** Only allow safe characters in session IDs */
const SAFE_SESSION_ID = /^[a-zA-Z0-9_-]+$/;

function assertValidSessionId(id: string): void {
  if (!SAFE_SESSION_ID.test(id)) {
    throw new Error(
      `Invalid session ID "${id}": must match ${SAFE_SESSION_ID}`,
    );
  }
}

interface ProcessEntry {
  process: ChildProcess;
  outputBuffer: string[];
  createdAt: number;
}

const MAX_OUTPUT_LINES = 1000;

export function create(): Runtime {
  // Per-instance process map — each create() call gets its own isolated state
  const processes = new Map<string, ProcessEntry>();

  return {
    name: "process",

    async create(config: RuntimeCreateConfig): Promise<RuntimeHandle> {
      assertValidSessionId(config.sessionId);

      const child = spawn(config.launchCommand, {
        cwd: config.workspacePath,
        env: { ...process.env, ...config.environment },
        stdio: ["pipe", "pipe", "pipe"],
        shell: true,
      });

      const entry: ProcessEntry = {
        process: child,
        outputBuffer: [],
        createdAt: Date.now(),
      };

      // Capture stdout and stderr into rolling buffer
      const appendOutput = (data: Buffer) => {
        const lines = data.toString("utf-8").split("\n");
        for (const line of lines) {
          entry.outputBuffer.push(line);
        }
        // Trim buffer to max size
        if (entry.outputBuffer.length > MAX_OUTPUT_LINES) {
          entry.outputBuffer.splice(
            0,
            entry.outputBuffer.length - MAX_OUTPUT_LINES,
          );
        }
      };

      child.stdout?.on("data", appendOutput);
      child.stderr?.on("data", appendOutput);

      // Log exit — use once() to avoid listener leaks
      child.once("exit", () => {
        entry.outputBuffer.push(`[process exited with code ${child.exitCode}]`);
      });

      const handleId = config.sessionId;
      processes.set(handleId, entry);

      return {
        id: handleId,
        runtimeName: "process",
        data: {
          pid: child.pid,
          createdAt: entry.createdAt,
        },
      };
    },

    async destroy(handle: RuntimeHandle): Promise<void> {
      const entry = processes.get(handle.id);
      if (!entry) return;

      const child = entry.process;
      if (child.exitCode === null) {
        // Try graceful SIGTERM first
        child.kill("SIGTERM");

        // Give it 5 seconds, then SIGKILL — use once() to avoid listener leaks
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            if (child.exitCode === null) {
              child.kill("SIGKILL");
            }
            resolve();
          }, 5000);
          child.once("exit", () => {
            clearTimeout(timeout);
            resolve();
          });
        });
      }

      processes.delete(handle.id);
    },

    async sendMessage(handle: RuntimeHandle, message: string): Promise<void> {
      const entry = processes.get(handle.id);
      if (!entry) {
        throw new Error(`No process found for session ${handle.id}`);
      }

      const child = entry.process;
      if (!child.stdin || !child.stdin.writable) {
        throw new Error(`stdin not writable for session ${handle.id}`);
      }

      // Wrap write in a promise to handle backpressure and errors
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => reject(err);
        child.stdin!.once("error", onError);
        const flushed = child.stdin!.write(message + "\n", (err) => {
          child.stdin!.removeListener("error", onError);
          if (err) reject(err);
          else resolve();
        });
        if (!flushed) {
          child.stdin!.once("drain", () => resolve());
        }
      });
    },

    async getOutput(handle: RuntimeHandle, lines = 50): Promise<string> {
      const entry = processes.get(handle.id);
      if (!entry) return "";

      const buffer = entry.outputBuffer;
      const start = Math.max(0, buffer.length - lines);
      return buffer.slice(start).join("\n");
    },

    async isAlive(handle: RuntimeHandle): Promise<boolean> {
      const entry = processes.get(handle.id);
      if (!entry) return false;
      return entry.process.exitCode === null;
    },

    async getMetrics(handle: RuntimeHandle): Promise<RuntimeMetrics> {
      const entry = processes.get(handle.id);
      const createdAt = entry?.createdAt ?? Date.now();
      return {
        uptimeMs: Date.now() - createdAt,
      };
    },

    async getAttachInfo(handle: RuntimeHandle): Promise<AttachInfo> {
      const entry = processes.get(handle.id);
      if (!entry || entry.process.exitCode !== null) {
        return {
          type: "process",
          target: "",
          command: `# process for session ${handle.id} is no longer running`,
        };
      }
      return {
        type: "process",
        target: String(entry.process.pid),
      };
    },
  };
}

export default { manifest, create } satisfies PluginModule<Runtime>;
