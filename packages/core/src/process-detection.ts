import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  normalizeAgentPermissionMode,
  type AgentPermissionMode,
  type RuntimeHandle,
} from "./types.js";

const execFileAsync = promisify(execFile);

const DEFAULT_PS_CACHE_TTL_MS = 5_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

let psCache: { output: string; timestamp: number; promise?: Promise<string> } | null = null;

export interface AgentProcessDetectionOptions {
  psCacheTtlMs?: number;
  commandTimeoutMs?: number;
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function getCachedProcessList(cacheTtlMs: number, commandTimeoutMs: number): Promise<string> {
  const now = Date.now();
  if (psCache && now - psCache.timestamp < cacheTtlMs) {
    if (psCache.promise) return psCache.promise;
    return psCache.output;
  }

  const promise = execFileAsync("ps", ["-eo", "pid,tty,args"], {
    timeout: commandTimeoutMs,
  }).then(({ stdout }) => {
    if (psCache?.promise === promise) {
      psCache = { output: stdout, timestamp: Date.now() };
    }
    return stdout;
  });

  psCache = { output: "", timestamp: now, promise };

  try {
    return await promise;
  } catch {
    if (psCache?.promise === promise) {
      psCache = null;
    }
    return "";
  }
}

export function resetProcessListCache(): void {
  psCache = null;
}

export async function isAgentProcessRunning(
  handle: RuntimeHandle,
  processName: string,
  options: AgentProcessDetectionOptions = {},
): Promise<boolean> {
  const cacheTtlMs = options.psCacheTtlMs ?? DEFAULT_PS_CACHE_TTL_MS;
  const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;

  try {
    if (handle.runtimeName === "tmux" && handle.id) {
      const { stdout: ttyOut } = await execFileAsync(
        "tmux",
        ["list-panes", "-t", handle.id, "-F", "#{pane_tty}"],
        { timeout: commandTimeoutMs },
      );
      const ttys = ttyOut
        .trim()
        .split("\n")
        .map((tty) => tty.trim())
        .filter(Boolean);
      if (ttys.length === 0) return false;

      const psOut = await getCachedProcessList(cacheTtlMs, commandTimeoutMs);
      if (!psOut) return false;

      const ttySet = new Set(ttys.map((tty) => tty.replace(/^\/dev\//, "")));
      const processRe = new RegExp(`(?:^|/)${escapeRegex(processName)}(?:\\s|$)`);
      for (const line of psOut.split("\n")) {
        const cols = line.trimStart().split(/\s+/);
        if (cols.length < 3 || !ttySet.has(cols[1] ?? "")) continue;
        const args = cols.slice(2).join(" ");
        if (processRe.test(args)) {
          return true;
        }
      }
      return false;
    }

    const rawPid = handle.data["pid"];
    const pid = typeof rawPid === "number" ? rawPid : Number(rawPid);
    if (Number.isFinite(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        return true;
      } catch (err: unknown) {
        if (err instanceof Error && "code" in err && err.code === "EPERM") {
          return true;
        }
        return false;
      }
    }

    return false;
  } catch {
    return false;
  }
}

export function normalizePermissionMode(mode: string | undefined): AgentPermissionMode | undefined {
  return normalizeAgentPermissionMode(mode);
}
