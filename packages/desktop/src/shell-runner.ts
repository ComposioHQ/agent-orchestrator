import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { buildSpawnSpec } from "./shell-adapter.js";
import type { ShellCommandSpec } from "./types.js";

export interface RunningCommand {
  process: ChildProcessWithoutNullStreams;
  startedAt: Date;
  terminate: () => void;
}

export function runShellCommand(
  spec: ShellCommandSpec,
  opts?: {
    env?: Record<string, string>;
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
    onExit?: (code: number | null) => void;
  },
): RunningCommand {
  const spawnSpec = buildSpawnSpec(spec);
  const child = spawn(spawnSpec.executable, spawnSpec.args, {
    cwd: spawnSpec.cwd,
    env: opts?.env ? { ...process.env, ...opts.env } : process.env,
    windowsHide: true,
    stdio: "pipe",
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => opts?.onStdout?.(chunk));
  child.stderr.on("data", (chunk: string) => opts?.onStderr?.(chunk));
  child.on("exit", (code) => opts?.onExit?.(code));

  return {
    process: child,
    startedAt: new Date(),
    terminate: () => {
      if (process.platform === "win32") {
        child.kill("SIGTERM");
        return;
      }
      child.kill("SIGINT");
    },
  };
}
